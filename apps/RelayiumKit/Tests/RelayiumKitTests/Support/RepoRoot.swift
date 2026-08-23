import Foundation
import XCTest

/// **The one place a test in this target turns into a repository path.**
///
/// Roughly a fifth of the files here are source, project or asset guards: they
/// assert things about files that live OUTSIDE the package — `apps/ios`,
/// `apps/mac`, `web`, the two `project.pbxproj` files, the privacy manifests.
/// Every one of them had to get from its own `#filePath` to the repository
/// root, and every one of them did it the same way — a hand-counted chain of
/// `deletingLastPathComponent()`, four times here and five times there,
/// annotated with the directory names it was walking past.
///
/// Two things are wrong with a counted walk, and both are silent:
///
///  1. **The count is a hard-coded fact about a directory layout, restated ~30
///     times.** Move `Tests/RelayiumKitTests` one level, or add one, and every
///     one of those chains points somewhere else. Nothing fails to compile.
///  2. **What it points at is never checked.** A four-step walk that should
///     have been five yields `…/apps`, and `…/apps/apps/mac/Relayium` simply
///     does not exist — so a guard that reads a source and asserts a substring
///     is ABSENT passes, loudly and vacuously, over a file it never opened.
///
/// The second failure is the reason this exists. A negative assertion over
/// missing input is indistinguishable from a negative assertion that holds, and
/// these guards are almost all negative: no `NSPasteboard` in the iOS layer, no
/// second constructor, no English literal. They are the tests most able to pass
/// while protecting nothing.
///
/// So: no counting, and no silent absence. The root is DISCOVERED by walking up
/// until a directory carries every marker below, and every accessor here fails
/// with the path it wanted when the file is not there.
///
/// ### Why the tests for this live in this file
///
/// This resolver is the thing every other guard's inputs now pass through, so
/// its own failure modes have to be executable rather than argued. They are at
/// the bottom of this file — `RepoRootTests` — beside the code they are about,
/// including the source-policy scan that fails if a counted walk or a silent
/// `try?` fallback is reintroduced anywhere in this target.
enum RepoRoot {

    // MARK: - what makes a directory the repository root

    /// Files that exist at the repository root and nowhere below it.
    ///
    /// All of them must be present, and they are FILES rather than directories
    /// on purpose: `server`, `web` and `apps` are names common enough that a
    /// vendored or nested tree could plausibly carry one, while
    /// `apps/RelayiumKit/Package.swift` plus `server/go.mod` plus
    /// `web/package.json` plus `.github/workflows/ios.yml` together identify
    /// exactly one directory in any checkout of this repository.
    static let markers = [
        "apps/RelayiumKit/Package.swift",
        "server/go.mod",
        "web/package.json",
        ".github/workflows/ios.yml",
    ]

    /// Why a repository-derived path could not be produced.
    ///
    /// `CustomStringConvertible` because these reach a test report through
    /// `XCTest`'s thrown-error message, and "The operation couldn't be
    /// completed" is not something a future reader can act on. Each case names
    /// the path it wanted and what it was looking for.
    enum Failure: Error, CustomStringConvertible {
        case startPathIsRelative(String)
        case rootNotFound(start: String, searched: [String])
        case missing(relativePath: String, absolute: String)
        case notADirectory(relativePath: String, absolute: String)
        case notAFile(relativePath: String, absolute: String)

        var description: String {
            switch self {
            case .startPathIsRelative(let path):
                return "repository discovery needs an absolute start path, got \(path). "
                    + "A relative path would be resolved against the process working "
                    + "directory, and where `swift test` is run from is not a fact this "
                    + "target may depend on."
            case .rootNotFound(let start, let searched):
                return "no repository root above \(start): walked \(searched.count) "
                    + "director\(searched.count == 1 ? "y" : "ies") up to "
                    + "\(searched.last ?? "/") without finding one carrying all of "
                    + "\(RepoRoot.markers.joined(separator: ", "))."
            case .missing(let relativePath, let absolute):
                return "the repository file \(relativePath) does not exist (looked at "
                    + "\(absolute)). A guard that reads it is asserting over nothing: "
                    + "either the file moved and this guard must follow it, or it was "
                    + "deleted and this guard is what should have said so."
            case .notADirectory(let relativePath, let absolute):
                return "the repository path \(relativePath) is not a directory "
                    + "(\(absolute)). A scan rooted here would walk nothing and report "
                    + "clean."
            case .notAFile(let relativePath, let absolute):
                return "the repository path \(relativePath) is a directory, not a file "
                    + "(\(absolute))."
            }
        }
    }

    // MARK: - discovery

    /// The repository root at or above `startPath`.
    ///
    /// Deterministic and free of process state: the only inputs are the path
    /// given and the file system. It never consults the working directory, and
    /// it rejects a relative start rather than quietly resolving one against
    /// it — see `Failure.startPathIsRelative`.
    ///
    /// The walk stops at the file-system root, so a start path that does not
    /// exist, or exists outside any checkout, THROWS. That is the case
    /// `RepoRootTests` drives adversarially: the whole point of this type is
    /// that a wrong answer is impossible to mistake for a right one.
    static func discover(from startPath: String,
                         fileManager: FileManager = .default) throws -> URL {
        guard startPath.hasPrefix("/") else { throw Failure.startPathIsRelative(startPath) }

        var candidate = URL(fileURLWithPath: startPath).standardizedFileURL
        var searched: [String] = []
        while true {
            searched.append(candidate.path)
            if carriesMarkers(candidate, fileManager: fileManager) { return candidate }
            let parent = candidate.deletingLastPathComponent().standardizedFileURL
            if parent.path == candidate.path { break }
            candidate = parent
        }
        throw Failure.rootNotFound(start: startPath, searched: searched)
    }

    /// Does this exact directory carry every marker?
    static func carriesMarkers(_ directory: URL,
                               fileManager: FileManager = .default) -> Bool {
        markers.allSatisfy { marker in
            fileManager.fileExists(atPath: directory.appendingPathComponent(marker).path)
        }
    }

    /// This file's own location, which is the start of the real walk.
    ///
    /// A `#filePath` default on a stored property would capture the caller's
    /// file, so it is taken here, once, from the file the resolver itself is
    /// compiled from.
    private static func ownFilePath(_ path: StaticString = #filePath) -> String {
        "\(path)"
    }

    /// Discovered once. `Result` rather than `try!` so a layout this cannot
    /// resolve reports as a test failure with the message above, at the point
    /// of use, instead of trapping the whole run in a static initializer.
    private static let resolved: Result<URL, Error> =
        Result { try discover(from: ownFilePath()) }

    /// The repository root.
    static func url() throws -> URL { try resolved.get() }

    // MARK: - repository paths, each of which must exist

    /// A repository path, checked for existence.
    static func url(_ relativePath: String) throws -> URL {
        let absolute = try url().appendingPathComponent(relativePath)
        guard FileManager.default.fileExists(atPath: absolute.path) else {
            throw Failure.missing(relativePath: relativePath, absolute: absolute.path)
        }
        return absolute
    }

    /// A repository directory, checked for existence AND for being a directory.
    ///
    /// The second half matters for the scan roots: `enumerator(at:)` over a
    /// regular file yields nothing and raises nothing, so a root that turned
    /// into a file would make every guard rooted there pass over zero files.
    static func directory(_ relativePath: String) throws -> URL {
        let absolute = try url().appendingPathComponent(relativePath)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: absolute.path,
                                             isDirectory: &isDirectory) else {
            throw Failure.missing(relativePath: relativePath, absolute: absolute.path)
        }
        guard isDirectory.boolValue else {
            throw Failure.notADirectory(relativePath: relativePath, absolute: absolute.path)
        }
        return absolute
    }

    /// A repository file's UTF-8 text. Missing is an error, never `""`.
    static func text(_ relativePath: String) throws -> String {
        let absolute = try url().appendingPathComponent(relativePath)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: absolute.path,
                                             isDirectory: &isDirectory) else {
            throw Failure.missing(relativePath: relativePath, absolute: absolute.path)
        }
        guard !isDirectory.boolValue else {
            throw Failure.notAFile(relativePath: relativePath, absolute: absolute.path)
        }
        return try String(contentsOf: absolute, encoding: .utf8)
    }

    /// A repository file's bytes. Missing is an error.
    static func data(_ relativePath: String) throws -> Data {
        try Data(contentsOf: try url(relativePath))
    }

    /// The UTF-8 text of an absolute file reached by a directory walk.
    ///
    /// The walking guards used `(try? String(contentsOf:)) ?? ""`, which turns
    /// an unreadable source into an empty one — and an empty source satisfies
    /// every "this file must NOT contain X" assertion in this target. This is
    /// the replacement, and it throws.
    static func text(of absolute: URL) throws -> String {
        try String(contentsOf: absolute, encoding: .utf8)
    }

    // MARK: - the trees the guards actually name

    /// `<root>/apps`.
    static func apps() throws -> URL { try directory("apps") }

    /// `<root>/apps/RelayiumKit` — this package.
    static func package() throws -> URL { try directory("apps/RelayiumKit") }

    /// This test target's own directory, which the source policy below scans.
    static func testsRoot() throws -> URL {
        try directory("apps/RelayiumKit/Tests/RelayiumKitTests")
    }

    /// Every `.swift` file under a repository directory that must exist.
    ///
    /// Sorted so a failure names the same file on every machine, and non-empty
    /// by construction: a root that suddenly contains no Swift at all is the
    /// same silent-pass shape as a missing root, so it throws rather than
    /// returning `[]`.
    static func swiftFiles(under relativePath: String) throws -> [URL] {
        let root = try directory(relativePath)
        let found = try swiftFiles(in: root)
        guard !found.isEmpty else {
            throw Failure.missing(relativePath: "\(relativePath)/**/*.swift",
                                  absolute: root.path)
        }
        return found
    }

    /// Every `.swift` file under an already-validated directory.
    static func swiftFiles(in root: URL) throws -> [URL] {
        guard let walk = FileManager.default.enumerator(at: root,
                                                        includingPropertiesForKeys: nil) else {
            throw Failure.notADirectory(relativePath: root.lastPathComponent,
                                        absolute: root.path)
        }
        return walk.compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.path < $1.path }
    }
}

// MARK: - the source policy this resolver only half enforces
//
// `RepoRoot` removes the counted walks and the silent fallbacks that were
// there. Nothing about it stops the next one being typed: a counted walk is
// three lines and compiles, and `(try? String(contentsOf: url)) ?? ""` is
// shorter than the throwing version it replaced. Both would pass review as
// "how the file next to it does it" — which is exactly how there came to be
// thirty of them.
//
// So the shapes themselves are banned, in source, across this whole target.

/// A banned shape, and the sentence a future author gets instead of it.
struct BannedTestShape {
    let needle: String
    let why: String

    /// Every line of `source` carrying this shape, as `line-number: text`.
    ///
    /// Whole-line comments are dropped first. Several files here EXPLAIN the
    /// pattern they avoid — this one does, at length — and a raw substring scan
    /// would answer the prose rather than the code.
    func offences(in source: String) -> [String] {
        source.components(separatedBy: "\n").enumerated().compactMap { number, line in
            guard !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") else { return nil }
            guard line.contains(needle) else { return nil }
            return "\(number + 1): \(line.trimmingCharacters(in: .whitespaces))"
        }
    }
}

/// The shapes that make a repository-reading guard pass while reading nothing.
let bannedTestShapes = [
    BannedTestShape(
        needle: "URL(fileURLWithPath: #filePath)",
        why: "a repository path counted out of this file's own location. The count is a "
            + "hard-coded fact about the directory layout: move or nest this target and "
            + "the walk lands somewhere that does not exist, where every negative "
            + "assertion below it passes over a file that was never opened. Use "
            + "`RepoRoot.text(_:)`, `RepoRoot.directory(_:)` or `RepoRoot.url(_:)`, which "
            + "discover the root by marker and throw when the input is missing."),
    BannedTestShape(
        needle: "URL(fileURLWithPath: #file)",
        why: "the same counted walk, spelled with `#file`. Use `RepoRoot`."),
    BannedTestShape(
        needle: "try? String(contentsOf",
        why: "an unreadable source read as `nil` and then, invariably, as `\"\"`. Every "
            + "source guard here asserts that some text is ABSENT, and it is absent from "
            + "the empty string — so this turns a moved or deleted file into a pass. Use "
            + "`RepoRoot.text(_:)` or `RepoRoot.text(of:)` and let the test throw."),
    // `try? Data(contentsOf:)` is deliberately NOT banned. Two uses of it here
    // read things that are not repository guard inputs at all — a sandbox
    // temp file this target wrote itself, and CoreGlyphs on the test HOST,
    // which `IOSSurfaceGuardTests` skips on rather than claims a verdict
    // without. Repository bytes have one route now (`RepoRoot.data(_:)`), and
    // banning the spelling would only teach the next author to work around the
    // ban.
    BannedTestShape(
        needle: "fileExists(atPath: root.path) else { continue }",
        why: "a scan root that vanished, skipped in silence. The loop then scans nothing "
            + "and the guard reports clean. Use `RepoRoot.directory(_:)`, which throws with "
            + "the path it wanted."),
]

/// **The resolver's own failure modes, and the ban on reintroducing them.**
final class RepoRootTests: XCTestCase {

    // MARK: - positive discovery

    /// The real root is found, and it is a real ancestor of this file.
    func testTheRepositoryRootIsDiscoveredAndCarriesEveryMarker() throws {
        let root = try RepoRoot.url()
        XCTAssertTrue(RepoRoot.carriesMarkers(root),
                      "\(root.path) was returned as the root without carrying the markers")
        for marker in RepoRoot.markers {
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: root.appendingPathComponent(marker).path),
                "\(marker) is missing from the discovered root \(root.path)")
        }
        XCTAssertTrue("\(#filePath)".hasPrefix(root.path + "/"),
                      "the discovered root \(root.path) is not an ancestor of \(#filePath)")
    }

    /// The accessors resolve real repository inputs, including ones outside the
    /// package — which is the whole reason this type exists.
    func testTheAccessorsReachTheTreesTheGuardsRead() throws {
        XCTAssertEqual(try RepoRoot.package().lastPathComponent, "RelayiumKit")
        XCTAssertEqual(try RepoRoot.apps().lastPathComponent, "apps")
        XCTAssertFalse(try RepoRoot.text("apps/ios/Relayium.xcodeproj/project.pbxproj").isEmpty)
        XCTAssertFalse(try RepoRoot.data("apps/mac/Relayium/PrivacyInfo.xcprivacy").isEmpty)
        XCTAssertGreaterThan(try RepoRoot.swiftFiles(under: "apps/ios/Relayium").count, 1)
    }

    // MARK: - discovery does not count directories

    /// Discovery is by MARKER, not by depth: the same tree resolves from a file
    /// one level down and from one six levels down.
    ///
    /// This is the property a counted walk cannot have, and it is asserted
    /// against a synthetic tree rather than the real one so it stays true when
    /// this target moves.
    func testDiscoveryFindsTheSameRootFromEveryDepth() throws {
        let (root, deepest) = try syntheticRepository(depth: 6)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertEqual(try RepoRoot.discover(from: deepest.appendingPathComponent("deep.swift").path)
            .standardizedFileURL.path, root.standardizedFileURL.path)
        XCTAssertEqual(try RepoRoot.discover(from: root.appendingPathComponent("a").path)
            .standardizedFileURL.path, root.standardizedFileURL.path)
        XCTAssertEqual(try RepoRoot.discover(from: root.path).standardizedFileURL.path,
                       root.standardizedFileURL.path)
    }

    // MARK: - the adversarial half

    /// A start path that does not exist resolves to no root at all.
    ///
    /// The counted walk's answer to this input was a URL — a wrong one, which
    /// every caller then appended to and read from.
    func testANonexistentStartPathThrowsRatherThanReturningAPath() {
        let start = "/nonexistent-\(UUID().uuidString)/deep/tree/File.swift"
        XCTAssertThrowsError(try RepoRoot.discover(from: start)) { error in
            guard case RepoRoot.Failure.rootNotFound(let reported, _) = error else {
                return XCTFail("expected rootNotFound, got \(error)")
            }
            XCTAssertEqual(reported, start)
        }
    }

    /// A real directory with no markers above it is not a repository either.
    func testADirectoryWithNoMarkersAboveItThrows() throws {
        let scratch = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("repo-root-empty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }

        // `/tmp` on a macOS runner is not inside a checkout, so the walk reaches
        // `/` and stops. If it ever did sit inside one, this would be reported
        // as a broken assumption rather than passing quietly.
        XCTAssertFalse(RepoRoot.carriesMarkers(URL(fileURLWithPath: "/")),
                       "the file-system root carries repository markers")
        XCTAssertThrowsError(try RepoRoot.discover(from: scratch.path)) { error in
            guard case RepoRoot.Failure.rootNotFound(_, let searched) = error else {
                return XCTFail("expected rootNotFound, got \(error)")
            }
            XCTAssertEqual(searched.last, "/", "the walk stopped before the file-system root")
        }
    }

    /// Nearly all the markers is not the root. A partial match is how a walk
    /// would stop one directory early and stay plausible.
    func testAPartialMarkerSetIsNotARepositoryRoot() throws {
        for omitted in RepoRoot.markers {
            let (root, deepest) = try syntheticRepository(depth: 2, omitting: omitted)
            defer { try? FileManager.default.removeItem(at: root) }
            XCTAssertThrowsError(try RepoRoot.discover(from: deepest.path),
                                 "a tree missing only \(omitted) was accepted as the root")
        }
    }

    /// A relative start is refused, not resolved. Where `swift test` was invoked
    /// from is not an input this target may have.
    func testARelativeStartPathIsRefusedRatherThanResolvedAgainstTheWorkingDirectory() {
        XCTAssertThrowsError(try RepoRoot.discover(from: "Tests/RelayiumKitTests")) { error in
            guard case RepoRoot.Failure.startPathIsRelative = error else {
                return XCTFail("expected startPathIsRelative, got \(error)")
            }
        }
    }

    /// A missing repository input is an error carrying the path, never an empty
    /// string and never an empty scan.
    func testMissingRepositoryInputsFailWithThePathTheyWanted() {
        let gone = "apps/ios/Relayium/NoSuchFile-\(UUID().uuidString).swift"
        XCTAssertThrowsError(try RepoRoot.text(gone)) { error in
            guard case RepoRoot.Failure.missing(let relative, _) = error else {
                return XCTFail("expected missing, got \(error)")
            }
            XCTAssertEqual(relative, gone)
            XCTAssertTrue("\(error)".contains(gone), "the message does not name the path")
        }
        XCTAssertThrowsError(try RepoRoot.data(gone))
        XCTAssertThrowsError(try RepoRoot.url(gone))
        XCTAssertThrowsError(try RepoRoot.directory("apps/nowhere-\(UUID().uuidString)"))
        XCTAssertThrowsError(try RepoRoot.swiftFiles(under: "apps/nowhere-\(UUID().uuidString)"))
        // A directory read as a file, and a file scanned as a directory: both are
        // the "read nothing, report clean" shape one level up.
        XCTAssertThrowsError(try RepoRoot.text("apps/ios"))
        XCTAssertThrowsError(try RepoRoot.directory("apps/RelayiumKit/Package.swift"))
    }

    // MARK: - the ban, and the proof the ban can fire

    /// Every banned shape is actually detected, and clean code is not.
    ///
    /// Without this, the scan below could be matching nothing at all and would
    /// report the same green as a clean target.
    func testTheSourcePolicyDetectorFiresOnEachBannedShapeAndNotOnCleanCode() {
        let samples = [
            "URL(fileURLWithPath: #filePath)":
                "        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()",
            "URL(fileURLWithPath: #file)":
                "        let root = URL(fileURLWithPath: #file).deletingLastPathComponent()",
            "try? String(contentsOf":
                "        return (try? String(contentsOf: file, encoding: .utf8)) ?? \"\"",
            "fileExists(atPath: root.path) else { continue }":
                "            guard FileManager.default.fileExists(atPath: root.path)"
                + " else { continue }",
        ]
        for shape in bannedTestShapes {
            let sample = try? XCTUnwrap(samples[shape.needle],
                                        "no sample for the banned shape \(shape.needle)")
            guard let sample else { continue }
            XCTAssertEqual(shape.offences(in: sample).count, 1,
                           "the ban on \(shape.needle) does not fire on \(sample)")
            // A file that only TALKS about the shape is not an offender.
            XCTAssertTrue(shape.offences(in: "    // \(sample)").isEmpty,
                          "the ban on \(shape.needle) fired on a comment")
            XCTAssertTrue(shape.offences(in: "        let x = try RepoRoot.text(path)").isEmpty)
        }
        XCTAssertEqual(bannedTestShapes.count, samples.count,
                       "a banned shape was added without a sample proving it fires")
    }

    /// **No file in this target derives a repository path by counting, or reads
    /// a guard input in a way that turns missing into empty.**
    func testNoTestFileCountsItsWayToTheRepositoryOrSwallowsAMissingSource() throws {
        // This file states the banned shapes as literals, so it necessarily
        // contains them. It is the resolver, and it is the one file whose own
        // discovery behaviour is proved by the executable cases above.
        let exempt = "RepoRoot.swift"
        let files = try RepoRoot.swiftFiles(in: try RepoRoot.testsRoot())
            .filter { $0.lastPathComponent != exempt }
        // A scan that reached nothing would report the same clean as a clean
        // target. This number is far below the current count and exists only to
        // make an empty walk loud.
        XCTAssertGreaterThan(files.count, 200,
                             "the source-policy scan did not reach this target's files")

        var offences: [String] = []
        for file in files {
            let source = try RepoRoot.text(of: file)
            for shape in bannedTestShapes where !shape.offences(in: source).isEmpty {
                for offence in shape.offences(in: source) {
                    offences.append("\(file.lastPathComponent):\(offence)\n      → \(shape.why)")
                }
            }
        }
        XCTAssertEqual(offences, [], "\n  " + offences.joined(separator: "\n  "))
    }

    // MARK: - helpers

    /// A throwaway tree carrying the real markers, `depth` directories deep.
    ///
    /// Returns the root and the deepest directory, so a caller can start the
    /// walk from either end.
    private func syntheticRepository(depth: Int,
                                     omitting: String? = nil) throws -> (root: URL, deepest: URL) {
        let fm = FileManager.default
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("repo-root-\(UUID().uuidString)")
        for marker in RepoRoot.markers where marker != omitting {
            let file = root.appendingPathComponent(marker)
            try fm.createDirectory(at: file.deletingLastPathComponent(),
                                   withIntermediateDirectories: true)
            try Data("marker\n".utf8).write(to: file)
        }
        var deepest = root
        for level in 0..<depth {
            deepest = deepest.appendingPathComponent("level\(level)")
        }
        try fm.createDirectory(at: deepest, withIntermediateDirectories: true)
        return (root, deepest)
    }
}
