import Foundation
@preconcurrency import RelayiumKit

/// Turning a decrypted, sender-controlled manifest into the exact set of local
/// paths one delivery is allowed to create.
///
/// AEAD proves the manifest was built by whoever holds the content key. It does
/// NOT make the names inside it safe: the sender is another machine, possibly
/// compromised, and a name is an INSTRUCTION to this filesystem. Everything below
/// treats a manifest name as hostile input.
///
/// The plan is computed ONCE, before anything is downloaded, and journalled
/// before anything is committed. That ordering is what makes a crash resumable:
/// the set of destinations a task may ever create is fixed and durable before the
/// first one exists, so recovery never re-derives it from a directory that has
/// since changed — which would walk the collision suffix forward and deliver the
/// same file twice.
///
/// This is deliberately NOT `ManifestWriter`/`safePathSegments`. Those two
/// STRIP control and bidi characters and then write straight into the
/// destination, cleaning up on failure; that is right for an interactive
/// download the user is watching, where a repaired name beats a refused
/// transfer. A Device Inbox delivery is unattended: a repaired name is a file the
/// user never approved appearing on their disk under a name nobody chose, and a
/// direct write has no crash boundary a journal can answer. Reusing the writer
/// here would import its ownership and cleanup semantics along with its path
/// rules.

/// One manifest entry bound to the one path it may ever create.
///
/// `name` and `destination` are plaintext-derived and therefore LOCAL ONLY: they
/// live in the journal so a crash can resume, and they are never logged, never
/// printed, and never sent to central.
public struct InboxPlanEntry: Codable, Equatable, Sendable {
    public let index: Int
    public let name: String
    public let size: Int
    /// Absolute path, as an on-disk string rather than a `URL`, because it is
    /// journalled and compared byte-for-byte across runs.
    public let destination: String

    public init(index: Int, name: String, size: Int, destination: String) {
        self.index = index
        self.name = name
        self.size = size
        self.destination = destination
    }
}

public enum InboxPlanError: Error, Equatable, Sendable {
    /// A manifest entry this device refuses to materialise. Terminal: the same
    /// bytes are refused the same way on every retry.
    case unsafeName(index: Int)
    /// Two entries resolve to one destination, including differing only by case.
    /// A REFUSAL rather than a rename: two entries that differ only by case are
    /// the sender describing two files, and quietly renaming one would hide that
    /// this receiver cannot represent what was sent.
    case duplicateDestination(index: Int)
    /// Every deterministic candidate name is taken. A human has to look.
    case noFreeName(index: Int)
}

public enum InboxDestinationPlan {
    /// Bounds directory nesting created for one task. Deep trees are legitimate;
    /// unbounded depth is a cheap way to exhaust path limits and make cleanup
    /// expensive.
    static let maxPathDepth = 32
    /// Bounds the deterministic `name (2)` search. Reaching it means the folder
    /// genuinely holds thousands of same-named files, which is a human problem.
    static let maxCollisionIndex = 1000

    /// The per-task staging area, created INSIDE the receive directory so the
    /// final commit is a same-filesystem `link` and can be atomic. A staging area
    /// on another filesystem would silently degrade the commit to a copy,
    /// reintroducing the partially-written-file window this design removes.
    public static let stagingDirectoryName = ".relayium-incoming"

    /// The entries in the receive directory that belong to this component, and
    /// which a manifest may therefore never name.
    ///
    /// Both are real hazards, not tidiness. A delivery into `stagingDirectoryName`
    /// would land ON its own staged source, so the commit would link the file to
    /// itself and then unlink it — reporting `saved` with nothing on disk. A
    /// delivery named `probeName` would be DELETED by the next writability probe,
    /// which removes a stale probe file it assumes it left behind.
    static var reservedTopLevelNames: Set<String> {
        [stagingDirectoryName, InboxReceiveFolder.probeName]
    }

    /// Windows device names. A file cannot be created with any of them, with or
    /// without an extension, in any case. Refused on macOS TOO, on purpose: one
    /// manifest is then accepted or refused identically on every receiver, and a
    /// name only some of a user's devices can receive is worse than one none can.
    static let reservedDeviceNames: Set<String> = [
        "con", "prn", "aux", "nul",
        "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ]

    /// Validate one manifest name and return it as a cleaned, slash-separated
    /// relative path.
    ///
    /// The rules, and what each one stops:
    ///
    ///   - empty / oversized / invalid UTF-8: unrepresentable or unbounded input.
    ///     (Swift `String` is already valid UTF-8 by construction; the JSON
    ///     decoder that produced it would have refused otherwise.)
    ///   - control scalars, including NUL and DEL: a name that can truncate a C
    ///     string or rewrite a terminal line. REFUSED, not stripped.
    ///   - bidi controls: a name that reads one way in a UI and another on disk.
    ///   - a leading `/` or a drive/UNC prefix: an ABSOLUTE destination, which
    ///     would leave the receive directory entirely.
    ///   - `\` anywhere: the separator is `/` by protocol. A backslash is a legal
    ///     byte in a POSIX name but means "directory separator" on Windows, so one
    ///     manifest would produce different trees on different receivers.
    ///   - `.` or `..` components: traversal.
    ///   - empty components (`a//b`): two spellings of one path.
    ///   - a component ending in `.` or a space: Windows strips both silently, so
    ///     `x ` and `x` would collide there and not here.
    ///   - a Windows reserved device name.
    /// Returns nil for a name this device refuses. Nil rather than a thrown
    /// error because the caller is the only thing that knows which manifest INDEX
    /// is being refused, and an error carrying a placeholder index would be a
    /// value the caller has to remember to overwrite.
    public static func checkedRelativePath(_ name: String) -> String? {
        guard !name.isEmpty, name.utf8.count <= MANIFEST_MAX_NAME_BYTES else { return nil }
        for scalar in name.unicodeScalars {
            let v = scalar.value
            if v <= 0x1F || (v >= 0x7F && v <= 0x9F) { return nil }
        }
        guard stripBidi(name) == name else { return nil }
        guard !name.contains("\\") else { return nil }
        guard !name.hasPrefix("/") else { return nil }
        // `C:foo` is drive-relative and `C:/foo` drive-absolute on Windows.
        let chars = Array(name)
        if chars.count >= 2, chars[1] == ":" { return nil }
        let parts = name.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count <= maxPathDepth else { return nil }
        for part in parts {
            guard !part.isEmpty, part != ".", part != ".." else { return nil }
            guard !part.hasSuffix("."), !part.hasSuffix(" ") else { return nil }
            let stem = part.split(separator: ".", maxSplits: 1,
                                  omittingEmptySubsequences: false)[0].lowercased()
            guard !reservedDeviceNames.contains(stem) else { return nil }
        }
        return name
    }

    /// Split a file name into the part a collision suffix is inserted after and
    /// the extension that must be preserved.
    ///
    /// Preserving the extension is a product requirement, not cosmetics:
    /// `report (2)` with `.pdf` moved or dropped stops opening in the right
    /// application. The three shapes that need care:
    ///
    ///   - `notes`         -> (`notes`, ``)          no extension to keep
    ///   - `.bashrc`       -> (`.bashrc`, ``)        a dotfile is all stem
    ///   - `backup.tar.gz` -> (`backup`, `.tar.gz`)  a compound archive suffix
    static func splitBase(_ base: String) -> (stem: String, ext: String) {
        for compound in [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz4"] {
            if base.count > compound.count, base.lowercased().hasSuffix(compound) {
                let cut = base.index(base.endIndex, offsetBy: -compound.count)
                return (String(base[..<cut]), String(base[cut...]))
            }
        }
        // A leading dot is part of the name, not an extension marker.
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex,
              base.index(after: dot) != base.endIndex else {
            return (base, "")
        }
        return (String(base[..<dot]), String(base[dot...]))
    }

    /// The deterministic safe rename (PRD §9): `name (2)`, then `name (3)`, with
    /// the extension preserved.
    static func collisionName(_ base: String, _ n: Int) -> String {
        let (stem, ext) = splitBase(base)
        return "\(stem) (\(n))\(ext)"
    }

    /// Resolve every manifest entry to the exact path it may create, refusing the
    /// whole task rather than partially planning it.
    ///
    /// `exists` is injected so the plan can be computed against a snapshot and so
    /// a test can plant a destination between planning and commit. It must report
    /// whether ANYTHING occupies that path — a file, a directory, a socket, a FIFO,
    /// a device node or a DANGLING symlink — because all of those occupy the name
    /// and none may be written through.
    ///
    /// Ordering is manifest order and the collision search is lowest-index-first,
    /// so the same manifest against the same directory always produces the same
    /// plan. That determinism is what lets a resumed task compare its journalled
    /// plan against reality instead of guessing.
    /// Takes v2 manifest ITEMS rather than the shared manifest's file entries.
    /// A `.text` item has no name and no destination, so it is refused here as
    /// well as gated by the receiver: a planner that assumed its caller had
    /// already separated the kinds would create a destination for a nameless
    /// item the first time one forgot.
    public static func plan(root: URL, files: [InboxManifestItem],
                            exists: (String) -> Bool = InboxDestinationPlan.pathExists)
        throws -> [InboxPlanEntry] {
        let absRoot = root.standardizedFileURL.path
        var plan: [InboxPlanEntry] = []
        // Every path this plan will create, so two entries cannot be given the
        // same destination even when the directory is empty.
        var taken = Set<String>()
        // The same set, case-folded: a case-insensitive filesystem (APFS, HFS+)
        // would collapse two differently-cased names into one file.
        var lowered = Set<String>()
        // The case-folded destinations the MANIFEST asked for, before any
        // collision suffix.
        //
        // Kept separately from `lowered`, and the distinction is the whole reason
        // both exist. Two manifest entries whose REQUESTED destinations differ
        // only by case are the sender describing two files this receiver cannot
        // tell apart, and that is refused — renaming one would hide it. But an
        // entry whose requested name happens to equal the SUFFIX an earlier entry
        // was given (`a.txt` was taken, so it became `a (2).txt`, and the manifest
        // also contains a real `a (2).txt`) describes two perfectly distinct
        // files; that one steps aside to the next free name, exactly as it would
        // against any other occupied name.
        var requested = Set<String>()

        func occupied(_ path: String) -> Bool {
            taken.contains(path) || lowered.contains(path.lowercased()) || exists(path)
        }

        for (i, file) in files.enumerated() {
            guard file.kind == .file, let name = file.name,
                  let relative = checkedRelativePath(name) else {
                throw InboxPlanError.unsafeName(index: i)
            }
            let top = relative.split(separator: "/", maxSplits: 1).first.map(String.init) ?? relative
            guard !reservedTopLevelNames.contains(top) else {
                throw InboxPlanError.unsafeName(index: i)
            }

            var destination = absRoot
            for component in relative.split(separator: "/") {
                destination += "/" + component
            }
            // Belt and braces over the component checks: the joined path must
            // still be under the root. Cheap, and it catches any future
            // `sanitize` regression before it reaches the filesystem.
            guard destination.hasPrefix(absRoot + "/") else {
                throw InboxPlanError.unsafeName(index: i)
            }
            guard requested.insert(destination.lowercased()).inserted else {
                throw InboxPlanError.duplicateDestination(index: i)
            }

            var final = destination
            if occupied(final) {
                var found = false
                guard let slash = destination.lastIndex(of: "/") else {
                    throw InboxPlanError.unsafeName(index: i)
                }
                let directory = String(destination[..<slash])
                let base = String(destination[destination.index(after: slash)...])
                for n in 2...maxCollisionIndex {
                    let candidate = directory + "/" + collisionName(base, n)
                    if !occupied(candidate) {
                        final = candidate
                        found = true
                        break
                    }
                }
                guard found else { throw InboxPlanError.noFreeName(index: i) }
            }
            taken.insert(final)
            lowered.insert(final.lowercased())
            plan.append(InboxPlanEntry(index: i, name: name, size: file.size,
                                       destination: final))
        }
        return plan
    }

    /// Whether anything at all occupies `path`, without following a final
    /// symlink.
    ///
    /// `lstat` rather than `stat` is the point: a dangling symlink is not a free
    /// name, and a symlink pointing at somebody's `~/.ssh/authorized_keys` is
    /// emphatically not a free name.
    public static func pathExists(_ path: String) -> Bool {
        var st = stat()
        return lstat(path, &st) == 0
    }
}
