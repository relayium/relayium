import XCTest
@testable import RelayiumKit

/// `AppPairLinkHost`'s `stagedFile` command: one file the acceptance harness
/// staged on disk, sent through the production entry point.
///
/// ## How the gate is tested without linking the host
///
/// `RelayiumPeerKit` is deliberately reachable only from the acceptance
/// executables, so this target cannot import it — and the live host needs a
/// server, a room and a peer to construct. The gate is therefore written as a
/// FOUNDATION-ONLY region of `AppPairLinkHost.swift`, between two markers, and
/// this suite compiles THAT EXACT SOURCE with `swiftc` and runs it against a
/// real directory tree: real symbolic links, a real FIFO, a real directory.
/// Nothing here re-implements the rule; if the region changes, what runs
/// changes. (`DevicePairSeamTests` drives its harness rule the same way.)
///
/// The second layer — the descriptor the host actually opens — is
/// `FileURLSource`, which this target DOES link, so it is exercised directly.
final class AppPairLinkStagedFileTests: XCTestCase {
    private var sandbox: URL!
    private var run: URL!
    private var staged: URL!

    override func setUpWithError() throws {
        // `/var/folders/…` is itself reached through a symbolic link on macOS
        // (`/var` → `/private/var`), so every case below already runs under a
        // symlinked ANCESTOR — the shape the real artifact root has.
        sandbox = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("staged-file-\(UUID().uuidString)")
        run = sandbox.appendingPathComponent("run")
        staged = run.appendingPathComponent("native-staged")
        let fm = FileManager.default
        try fm.createDirectory(at: run.appendingPathComponent("native-received"),
                               withIntermediateDirectories: true)
        try fm.createDirectory(at: staged.appendingPathComponent("sub"),
                               withIntermediateDirectories: true)
        try fm.createDirectory(at: staged.appendingPathComponent("dir"),
                               withIntermediateDirectories: true)
        try fm.createDirectory(at: run.appendingPathComponent("native-staged-evil"),
                               withIntermediateDirectories: true)
        try Data("long file".utf8).write(to: staged.appendingPathComponent("file.bin"))
        try Data("nested".utf8).write(to: staged.appendingPathComponent("sub/inner.bin"))
        try Data("secret".utf8).write(to: run.appendingPathComponent("outside.bin"))
        try Data("evil".utf8).write(to: run.appendingPathComponent("native-staged-evil/file.bin"))
        // A leaf link and a parent link, both INSIDE staging, both pointing at
        // perfectly good targets — what is refused is the link, not the target.
        try fm.createSymbolicLink(at: staged.appendingPathComponent("leaf-link"),
                                  withDestinationURL: run.appendingPathComponent("outside.bin"))
        try fm.createSymbolicLink(at: staged.appendingPathComponent("dir-link"),
                                  withDestinationURL: staged.appendingPathComponent("sub"))
        XCTAssertEqual(mkfifo(staged.appendingPathComponent("fifo").path, 0o600), 0)
        // An aliased ancestor of the whole run directory.
        try fm.createSymbolicLink(at: sandbox.appendingPathComponent("alias"),
                                  withDestinationURL: run)
        // A run whose staging directory is ITSELF a link to a real one.
        try fm.createDirectory(at: sandbox.appendingPathComponent("run2"),
                               withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: sandbox.appendingPathComponent("run2/native-staged"),
                                  withDestinationURL: staged)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: sandbox)
    }

    // MARK: - the gate, compiled from the host's own source and executed

    func testTheGateAdmitsOnlyRegularFilesStrictlyInsideStaging() throws {
        let alias = sandbox.appendingPathComponent("alias/native-staged")
        let cases: [(label: String, root: URL, path: String, expect: String)] = [
            ("a staged file", staged, staged.path + "/file.bin", "ok"),
            ("a nested staged file", staged, staged.path + "/sub/inner.bin", "ok"),
            ("the same file through an aliased ANCESTOR", staged, alias.path + "/file.bin", "ok"),
            ("the root spelled through the alias", alias, staged.path + "/file.bin", "ok"),
            // The real runner's shape: its artifact root is a link, and it spells
            // BOTH the receive root and the staged path through that same link.
            ("root AND path both spelled through the alias", alias, alias.path + "/file.bin", "ok"),
            ("an escape spelled through the alias", alias, alias.path + "/../outside.bin",
             "outsideStaging"),
            ("a leaf link spelled through the alias", alias, alias.path + "/leaf-link", "symlink"),
            ("a relative path", staged, "file.bin", "notAbsolute"),
            ("a file beside staging", staged, run.path + "/outside.bin", "outsideStaging"),
            ("a `..` escape", staged, staged.path + "/../outside.bin", "outsideStaging"),
            ("a `.` component", staged, staged.path + "/./file.bin", "outsideStaging"),
            ("a doubled slash", staged, staged.path + "//file.bin", "outsideStaging"),
            ("a sibling sharing the name as a prefix", staged,
             run.path + "/native-staged-evil/file.bin", "outsideStaging"),
            ("the staging directory itself", staged, staged.path, "outsideStaging"),
            ("an arbitrary external file", staged, "/etc/hosts", "outsideStaging"),
            ("a leaf symbolic link", staged, staged.path + "/leaf-link", "symlink"),
            ("a parent symbolic link", staged, staged.path + "/dir-link/inner.bin", "symlink"),
            ("a directory", staged, staged.path + "/dir", "notRegularFile"),
            ("a FIFO", staged, staged.path + "/fifo", "notRegularFile"),
            ("a file through a regular file", staged, staged.path + "/file.bin/x", "outsideStaging"),
            ("a missing file", staged, staged.path + "/absent.bin", "missing"),
            ("a staging directory that is itself a link",
             sandbox.appendingPathComponent("run2/native-staged"),
             sandbox.path + "/run2/native-staged/file.bin", "stagingRootUnusable"),
            ("a staging directory that does not exist",
             sandbox.appendingPathComponent("nowhere/native-staged"),
             sandbox.path + "/nowhere/native-staged/file.bin", "stagingRootUnusable"),
        ]
        let lines = try runGate(cases.map { ($0.root.path, $0.path) })
        XCTAssertEqual(lines.count, cases.count, "one verdict per case: \(lines)")
        for (testCase, line) in zip(cases, lines) {
            let verdict = line.split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
            XCTAssertEqual(verdict, testCase.expect, "\(testCase.label): \(line)")
        }
        // An admitted path is reported CANONICALLY, whichever way it was spelled,
        // so what is opened is the resolved file and not a second resolution.
        let canonical = try XCTUnwrap(realpath(staged.path + "/file.bin", nil))
        defer { free(canonical) }
        for index in [0, 2, 3, 4] {
            XCTAssertEqual(lines[index], "ok " + String(cString: canonical), cases[index].label)
        }
    }

    /// The staging directory is `native-staged` BESIDE the receive root, which is
    /// the contract the launcher stages against.
    func testTheStagingDirectoryIsTheReceiveRootsSibling() throws {
        let lines = try runGate([], sibling: run.appendingPathComponent("native-received").path)
        let canonicalRun = try XCTUnwrap(realpath(run.path, nil))
        defer { free(canonicalRun) }
        XCTAssertEqual(lines.first.map { URL(fileURLWithPath: $0).lastPathComponent }, "native-staged")
        XCTAssertEqual(lines.first.map { URL(fileURLWithPath: $0).deletingLastPathComponent().path },
                       run.path)
    }

    // MARK: - the descriptor layer the host opens with

    /// What `admit` looked at can change before it is opened, so the host hands
    /// the path to `FileURLSource`, which decides on the DESCRIPTOR. Each of
    /// these is the swap that would matter, presented directly.
    func testTheDescriptorLayerRefusesWhatAnAdmittedPathCouldBecome() throws {
        XCTAssertThrowsError(try FileURLSource(url: staged.appendingPathComponent("leaf-link")),
                             "O_NOFOLLOW: a leaf swapped for a link is not followed")
        XCTAssertThrowsError(try FileURLSource(url: staged.appendingPathComponent("dir")))
        // Must RETURN. A blocking open on a FIFO would hang the main actor.
        XCTAssertThrowsError(try FileURLSource(url: staged.appendingPathComponent("fifo")))
        let source = try FileURLSource(url: staged.appendingPathComponent("file.bin"),
                                       name: "renamed.bin")
        XCTAssertEqual(source.size, 9, "the size is the opened file's, never the caller's")
        XCTAssertEqual(source.name, "renamed.bin")
    }

    // MARK: - the command itself

    /// The host is not constructible here, so how it USES the gate is pinned as
    /// source: gate first, then the descriptor, then the production `link.send`
    /// with the opened file's own size — and no change to what `files` accepts.
    func testTheCommandOpensOnlyWhatTheGateAdmittedAndSendsThroughTheProductionEntry() throws {
        let host = try RepoRoot.text("apps/RelayiumKit/Sources/RelayiumPeerKit/AppPairLinkHost.swift")
        let start = try XCTUnwrap(host.range(of: "case \"stagedFile\":"))
        let end = try XCTUnwrap(host.range(of: "default:", range: start.upperBound..<host.endIndex))
        let body = String(host[start.upperBound..<end.lowerBound])

        let root = try XCTUnwrap(body.range(of:
            "AppPairLinkStagedFile.stagingRoot(besideReceiveRoot: options.receiveRoot)"))
        let admit = try XCTUnwrap(body.range(of: "AppPairLinkStagedFile.admit(path: path, stagingRoot: root)"))
        let open = try XCTUnwrap(body.range(of: "FileURLSource(url: admitted, name: name)"))
        let send = try XCTUnwrap(body.range(of: "link.send(files: [meta], sources: [source])"))
        XCTAssertTrue(root.lowerBound < admit.lowerBound && admit.lowerBound < open.lowerBound
                      && open.lowerBound < send.lowerBound, "gate, then descriptor, then send")
        XCTAssertTrue(body.contains("FileMeta(name: name, size: source.size, path: nil)"))
        XCTAssertTrue(body.contains("return [\"ok\": true, \"size\": source.size]"))
        XCTAssertEqual(body.components(separatedBy: "FileURLSource(").count - 1, 1,
                       "exactly one open, and it is of the admitted URL")
        XCTAssertFalse(body.contains("contents"), "a staged file carries no bytes in the body")
        XCTAssertFalse(body.contains("Data(contentsOf"), "and is never read whole into memory")
        // The inline `files` command is untouched.
        XCTAssertTrue(host.contains("let bytes = [UInt8](Data(contents.utf8))"))
    }

    // MARK: - compiling the marked region on its own

    private func gateSource() throws -> String {
        let host = try RepoRoot.text("apps/RelayiumKit/Sources/RelayiumPeerKit/AppPairLinkHost.swift")
        let begin = try XCTUnwrap(host.range(of: "// staged-file gate: BEGIN"))
        let end = try XCTUnwrap(host.range(of: "// staged-file gate: END"))
        let region = String(host[begin.lowerBound..<end.lowerBound])
        XCTAssertFalse(region.contains("import "), "the region must not import a product module")
        return "import Foundation\n" + region
    }

    /// Compile the gate with a driver and run it. Arguments are
    /// `root path root path …`; with `sibling` set it prints the staging root
    /// derived from that receive root instead.
    private func runGate(_ pairs: [(String, String)], sibling: String? = nil) throws -> [String] {
        let build = sandbox.appendingPathComponent("build-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: build, withIntermediateDirectories: true)
        let subject = build.appendingPathComponent("Gate.swift")
        try gateSource().write(to: subject, atomically: true, encoding: .utf8)
        let main = build.appendingPathComponent("main.swift")
        try """
            import Foundation
            var args = Array(CommandLine.arguments.dropFirst())
            if args.first == "--sibling" {
                print(AppPairLinkStagedFile.stagingRoot(
                    besideReceiveRoot: URL(fileURLWithPath: args[1])).path)
                args = []
            }
            while args.count >= 2 {
                let root = URL(fileURLWithPath: args.removeFirst(), isDirectory: true)
                let path = args.removeFirst()
                switch AppPairLinkStagedFile.admit(path: path, stagingRoot: root) {
                case let .success(url): print("ok " + url.path)
                case let .failure(refusal): print(refusal.rawValue)
                }
            }
            """.write(to: main, atomically: true, encoding: .utf8)

        let binary = build.appendingPathComponent("gate")
        let compile = Process()
        compile.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        compile.arguments = ["swiftc", "-Onone", subject.path, main.path, "-o", binary.path]
        let diagnostics = Pipe()
        compile.standardError = diagnostics
        compile.standardOutput = Pipe()
        try compile.run()
        let errors = diagnostics.fileHandleForReading.readDataToEndOfFile()
        compile.waitUntilExit()
        guard compile.terminationStatus == 0 else {
            XCTFail("the staged-file gate does not compile on its own:\n"
                    + String(decoding: errors, as: UTF8.self))
            return []
        }

        let process = Process()
        process.executableURL = binary
        process.arguments = sibling.map { ["--sibling", $0] } ?? pairs.flatMap { [$0.0, $0.1] }
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        try process.run()
        let produced = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        return String(decoding: produced, as: UTF8.self)
            .components(separatedBy: "\n").filter { !$0.isEmpty }
    }
}
