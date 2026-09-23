import Darwin
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// W-C1 Stage 1-S: live whole-feature acceptance of the CLI sender against the
/// native receive engine, BY EXECUTION.
///
/// The REAL `relayium` CLI, built from this checkout, sends through a REAL
/// central (account.Service + in-memory SQLite + DiskStore on 127.0.0.1, hosted
/// by the Go helper `server/internal/inboxlive`) to the REAL `InboxClient` +
/// `InboxReceiveEngine` in this process, which enrols, claims, decrypts, commits
/// to disk and reports. Then a SEPARATE CLI process reads the task's state from
/// central on its own. Nothing on that path is a fake: no `FakeInboxTransport`,
/// no fixture decoder, no product seam.
///
/// The negative flips one byte inside the final frame's AES-GCM tag on the wire,
/// inside central's request path, and must leave no committed file, no success
/// receipt and a non-`saved` state.
///
/// Three further cases prove the harness is bounded rather than hopeful: a
/// helper that exits before it is ready, one that hangs deaf to every
/// cooperative stop, and a central request that never answers. Each must end
/// inside a stated bound, with every child reaped and the run directory gone.
///
/// `RELAYIUM_SWIFT_INTEROP`: `1` = run and never skip (every missing
/// prerequisite is a FAILURE); anything else = skip. Unlike the sealed-box class
/// this one does not auto-enable on a developer machine: it builds two Go
/// binaries and binds a socket.
///
/// `@MainActor` is load-bearing, not style. On this toolchain an `XCTAssert*`
/// raised off the main thread inside an `async` test is handed to the main
/// thread asynchronously, and one raised in the last moments of the test can
/// land AFTER XCTest has closed the run — the case is then reported with fewer
/// failures, or as passed (observed 2026-09-23: a negative control whose final
/// assertions all failed still reported only the earlier ones). Every
/// assertion here therefore runs on the main actor; only the awaited work
/// (processes, URLSession, the engine) runs elsewhere.
@MainActor
final class InboxCLISenderLiveInteropTests: XCTestCase {

    private static let mode = ProcessInfo.processInfo.environment["RELAYIUM_SWIFT_INTEROP"]

    // MARK: - errors

    /// Every harness failure is thrown as one of these. XCTest records a thrown
    /// non-skip error as a FAILURE, so a forced run cannot turn any of them into
    /// a skip, and the bounded-path cases can assert which one they got.
    enum LiveError: Error, Equatable, CustomStringConvertible {
        case noGoToolchain
        case buildFailed(String)
        case buildTimedOut(String)
        case helperExitedBeforeReady(Int32)
        case helperNotReady(seconds: Double)
        case deadline(String)
        case cliTimedOut(String)

        var description: String {
            switch self {
            case .noGoToolchain: return "RELAYIUM_SWIFT_INTEROP=1 but no Go toolchain; a forced run never skips"
            case .buildFailed(let what): return "build failed: \(what)"
            case .buildTimedOut(let what): return "build timed out: \(what)"
            case .helperExitedBeforeReady(let s): return "helper exited with status \(s) before it was ready"
            case .helperNotReady(let s): return "helper not ready within \(s) s"
            case .deadline(let what): return "harness deadline reached: \(what)"
            case .cliTimedOut(let what): return "relayium \(what) timed out"
            }
        }
    }

    // MARK: - owned processes

    /// How a child's life ended when this test stopped it.
    enum StopOutcome: Equatable {
        /// Exited on its own or after its stdin was closed.
        case exited(Int32)
        /// Needed SIGTERM.
        case terminated(Int32)
        /// Needed SIGKILL.
        case killed(Int32)
        /// Still alive, or not reaped, after SIGKILL and its wait. Always a failure.
        case notReaped
    }

    struct Grace {
        var afterStdinClose: TimeInterval = 10
        var afterTerm: TimeInterval = 5
        var afterKill: TimeInterval = 5
    }

    /// A child this test owns from spawn to reap. Output goes to FILES, never to
    /// a pipe the test must drain, so a chatty child cannot block and a hung one
    /// cannot hang a read.
    final class Owned: @unchecked Sendable {
        let name: String
        let process = Process()
        let stdoutURL: URL
        let stderrURL: URL
        let stdinPipe: Pipe?
        var grace = Grace()
        private let lock = NSLock()
        private var outcome: StopOutcome?

        init(_ exe: URL, _ args: [String], cwd: URL? = nil, env: [String: String],
             logs: URL, name: String, keepStdin: Bool = false) throws {
            self.name = name
            process.executableURL = exe
            process.arguments = args
            process.currentDirectoryURL = cwd
            process.environment = env
            stdoutURL = logs.appendingPathComponent("\(name).stdout")
            stderrURL = logs.appendingPathComponent("\(name).stderr")
            FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
            FileManager.default.createFile(atPath: stderrURL.path, contents: nil)
            process.standardOutput = try FileHandle(forWritingTo: stdoutURL)
            process.standardError = try FileHandle(forWritingTo: stderrURL)
            if keepStdin {
                let pipe = Pipe()
                process.standardInput = pipe
                stdinPipe = pipe
            } else {
                process.standardInput = FileHandle.nullDevice
                stdinPipe = nil
            }
        }

        var pid: pid_t { process.processIdentifier }

        /// Poll to a deadline. nil = still running when it passed.
        func wait(seconds: TimeInterval) async -> Int32? {
            let end = Date().addingTimeInterval(seconds)
            while process.isRunning {
                if Date() >= end { return nil }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return process.terminationStatus
        }

        /// True once the kernel no longer knows the pid: exited AND waited for.
        /// Foundation reaps a `Process` itself; this checks that it happened.
        private func reaped() async -> Bool {
            for _ in 0..<40 {
                if kill(pid, 0) == -1 && errno == ESRCH { return true }
                try? await Task.sleep(nanoseconds: 25_000_000)
            }
            return false
        }

        /// Close stdin, then SIGTERM, then SIGKILL, each with a bounded wait; the
        /// result says which step ended it, or `.notReaped`. Idempotent.
        @discardableResult
        func stop() async -> StopOutcome {
            if let done = lock.withLock({ outcome }) { return done }
            var result: StopOutcome
            try? stdinPipe?.fileHandleForWriting.close()
            if let s = await wait(seconds: grace.afterStdinClose) {
                result = .exited(s)
            } else {
                process.terminate()
                if let s = await wait(seconds: grace.afterTerm) {
                    result = .terminated(s)
                } else {
                    kill(pid, SIGKILL)
                    if let s = await wait(seconds: grace.afterKill) {
                        result = .killed(s)
                    } else {
                        result = .notReaped
                    }
                }
            }
            if result != .notReaped, !(await reaped()) { result = .notReaped }
            lock.withLock { outcome = result }
            return result
        }

        var stdout: String { (try? String(contentsOf: stdoutURL, encoding: .utf8)) ?? "" }
        var stderr: String { (try? String(contentsOf: stderrURL, encoding: .utf8)) ?? "" }
    }

    /// Everything one case started, registered the moment it exists, torn down
    /// on every exit path. The teardown block is added BEFORE any child is
    /// spawned, so a failure at any later step still stops, reaps and removes.
    final class LiveRun: @unchecked Sendable {
        let dir: URL
        let logs: URL
        let bin: URL
        private let lock = NSLock()
        private var children: [Owned] = []
        private var sessions: [URLSession] = []
        private(set) var outcomes: [String: StopOutcome] = [:]

        init() throws {
            dir = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("relayium-swift-live-\(UUID().uuidString)")
            logs = dir.appendingPathComponent("logs")
            bin = dir.appendingPathComponent("bin")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            // createDirectory's attributes are filtered by the umask; set it exactly.
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: false)
            try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: false)
        }

        /// Spawn and register in one step: a child that runs is always owned.
        func spawn(_ exe: URL, _ args: [String], cwd: URL? = nil, env: [String: String],
                   name: String, keepStdin: Bool = false, grace: Grace = Grace()) throws -> Owned {
            let child = try Owned(exe, args, cwd: cwd, env: env, logs: logs, name: name, keepStdin: keepStdin)
            child.grace = grace
            lock.withLock { children.append(child) }
            try child.process.run()
            return child
        }

        func own(_ session: URLSession) { lock.withLock { sessions.append(session) } }

        /// Stop every child (newest first), cancel every owned session, remove
        /// the run directory. Returns the children that were NOT reaped.
        @discardableResult
        func cleanup() async -> [String] {
            let (kids, owned) = lock.withLock { (children, sessions) }
            owned.forEach { $0.invalidateAndCancel() }
            var unreaped: [String] = []
            for child in kids.reversed() {
                let outcome = await child.stop()
                lock.withLock { outcomes[child.name] = outcome }
                if outcome == .notReaped { unreaped.append("\(child.name) pid \(child.pid)") }
            }
            try? FileManager.default.removeItem(at: dir)
            return unreaped
        }
    }

    private func makeRun() throws -> LiveRun {
        guard Self.mode == "1" else {
            throw XCTSkip("RELAYIUM_SWIFT_INTEROP != 1")   // nonlocalized: skip reason, never rendered
        }
        let run = try LiveRun()
        addTeardownBlock { @MainActor [run] in
            let unreaped = await run.cleanup()
            XCTAssertEqual(unreaped, [], "children survived teardown")
            XCTAssertFalse(FileManager.default.fileExists(atPath: run.dir.path), "run directory left behind")
        }
        return run
    }

    // MARK: - toolchain and builds

    private func goExecutable() -> URL? {
        var dirs = ["/opt/homebrew/bin", "/usr/local/go/bin", "/usr/local/bin", "/opt/homebrew/opt/go/bin"]
        dirs += (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        for d in dirs where FileManager.default.isExecutableFile(atPath: d + "/go") {
            return URL(fileURLWithPath: d + "/go")
        }
        return nil
    }

    /// The Go toolchain keeps the caller's module/build caches (CI caches them;
    /// they are not user configuration).
    private var buildEnv: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["GOWORK"] = "off"
        env["GOFLAGS"] = "-mod=readonly"
        return env
    }

    /// The programs under test never see the caller's HOME, so no real
    /// credential or configuration can be read or written.
    private func programEnv(_ run: LiveRun) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        for k in ["GOCACHE", "GOMODCACHE", "GOPATH", "GOFLAGS", "GOTOOLCHAIN", "GOWORK"] { env.removeValue(forKey: k) }
        env["HOME"] = run.dir.path
        env["XDG_CONFIG_HOME"] = run.dir.appendingPathComponent("xdg").path
        return env
    }

    private static let buildSeconds: TimeInterval = 480

    private func goBuild(_ run: LiveRun, _ args: [String], name: String) async throws {
        guard let go = goExecutable() else { throw LiveError.noGoToolchain }
        let started = Date()
        let child = try run.spawn(go, args, cwd: try RepoRoot.directory("server"), env: buildEnv, name: name)
        guard let status = await child.wait(seconds: Self.buildSeconds) else {
            await child.stop()
            throw LiveError.buildTimedOut(name)
        }
        guard status == 0 else { throw LiveError.buildFailed("\(name) exit \(status):\n\(child.stderr)") }
        print("LIVE-TIMING \(name) \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
    }

    // MARK: - world

    struct World {
        let run: LiveRun
        let helper: Owned
        let meta: [String: String]
        let relayium: URL?
    }

    private func startWorld(_ run: LiveRun, fault: String, withCLI: Bool,
                            readySeconds: TimeInterval = 60, helperGrace: Grace = Grace()) async throws -> World {
        var relayium: URL?
        if withCLI {
            let exe = run.bin.appendingPathComponent("relayium")
            try await goBuild(run, ["build", "-o", exe.path, "./cmd/relayium"], name: "go-build-relayium")
            relayium = exe
        }
        let helperBin = run.bin.appendingPathComponent("inboxlive.test")
        try await goBuild(run, ["test", "-c", "-tags", "swiftinterop", "-o", helperBin.path, "./internal/inboxlive/"],
                          name: "go-test-c-inboxlive")

        var env = programEnv(run)
        env["RELAYIUM_SWIFT_LIVE_DIR"] = run.dir.path
        env["RELAYIUM_SWIFT_LIVE_FAULT"] = fault
        let helper = try run.spawn(helperBin, ["-test.run", "^TestSwiftLiveInteropCentral$", "-test.count=1",
                                               "-test.timeout=200s", "-test.v"],
                                   env: env, name: "helper", keepStdin: true, grace: helperGrace)
        let ready = run.dir.appendingPathComponent("ready.json")
        let end = Date().addingTimeInterval(readySeconds)
        while !FileManager.default.fileExists(atPath: ready.path) {
            if !helper.process.isRunning {
                throw LiveError.helperExitedBeforeReady(helper.process.terminationStatus)
            }
            if Date() >= end { throw LiveError.helperNotReady(seconds: readySeconds) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let attrs = try FileManager.default.attributesOfItem(atPath: ready.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600, "ready.json must be 0600")
        let meta = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: String])
        XCTAssertNotEqual(meta["receiverDeviceId"], meta["senderDeviceId"])
        return World(run: run, helper: helper, meta: meta, relayium: relayium)
    }

    private static let cliSeconds: TimeInterval = 90

    private func cli(_ w: World, _ args: [String], name: String) async throws -> (Int32, String, String) {
        let exe = try XCTUnwrap(w.relayium)
        let p = try w.run.spawn(exe, args, env: programEnv(w.run), name: name)
        guard let status = await p.wait(seconds: Self.cliSeconds) else {
            await p.stop()
            throw LiveError.cliTimedOut(args.prefix(2).joined(separator: " "))
        }
        return (status, p.stdout, p.stderr)
    }

    // MARK: - bounded engine calls

    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var raised = false
        func raise() { lock.withLock { raised = true } }
        var isRaised: Bool { lock.withLock { raised } }
    }

    /// Run one engine call under a deadline that is enforced on the TRANSPORT,
    /// not by racing a sleep: when it fires, the URLSession the engine talks
    /// through is invalidated and every in-flight request cancelled (which is
    /// what makes a hung `await` return), and the work task is cancelled. The
    /// call is then awaited to its real end — nothing is left running behind a
    /// "timed out" verdict. `testAHungCentralRequestIsTornDownByTheDeadline`
    /// proves the teardown actually reaches central.
    private func bounded<T: Sendable>(_ label: String, seconds: TimeInterval, session: URLSession,
                                      _ op: @escaping @Sendable () async throws -> T) async throws -> T {
        let fired = Flag()
        let work = Task { try await op() }
        let watchdog = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            fired.raise()
            session.invalidateAndCancel()
            work.cancel()
        }
        defer { watchdog.cancel() }
        do {
            let value = try await work.value
            if fired.isRaised { throw LiveError.deadline(label) }
            return value
        } catch {
            if fired.isRaised { throw LiveError.deadline(label) }
            throw error
        }
    }

    // MARK: - engine

    private final class PassBookmarks: InboxFolderBookmarking, @unchecked Sendable {
        let url: URL
        init(_ url: URL) { self.url = url }
        func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
        func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) { (url, false) }
        func startAccess(to url: URL) -> Bool { true }
        func stopAccess(to url: URL) {}
    }

    private final class Receipts: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [InboxReceipt] = []
        func add(_ r: InboxReceipt) { lock.withLock { items.append(r) } }
        var count: Int { lock.withLock { items.count } }
    }

    private struct Receiver {
        let engine: InboxReceiveEngine
        let session: URLSession
        let root: URL
        let receipts: Receipts
    }

    private func receiver(_ w: World) throws -> Receiver {
        let root = w.run.dir.appendingPathComponent("receive")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let session = URLSession(configuration: .ephemeral)
        w.run.own(session)
        let base = try XCTUnwrap(URL(string: try XCTUnwrap(w.meta["url"])))
        let client = try InboxClient(baseURL: base, deviceID: try XCTUnwrap(w.meta["receiverDeviceId"]),
                                     token: try XCTUnwrap(w.meta["receiverToken"]), session: session)
        let account = try InboxAccountID(try XCTUnwrap(w.meta["accountId"]))
        let folder = InboxReceiveFolder(store: InMemoryInboxFolderStore(), bookmarking: PassBookmarks(root))
        _ = try folder.chooseFolder(root, account: account)
        try folder.setAutomaticReceive(true, account: account)
        let receipts = Receipts()
        var engine = InboxReceiveEngine(transport: client, keys: InMemoryInboxDeviceKeyStore(),
                                        journals: InboxJournalStore(directory: w.run.dir.appendingPathComponent("journals")),
                                        messages: InboxMessageStore(directory: w.run.dir.appendingPathComponent("messages")),
                                        folder: folder, account: account)
        // Required: the engine refuses to commit without it, and it is the local
        // witness that a durable commit happened.
        engine.onReceipt = { receipts.add($0) }
        return Receiver(engine: engine, session: session, root: root, receipts: receipts)
    }

    private static let engineSeconds: TimeInterval = 120

    private func prepare(_ r: Receiver) async throws {
        let engine = r.engine
        _ = try await bounded("prepare", seconds: Self.engineSeconds, session: r.session) {
            try await engine.prepare(platform: "darwin", appVersion: "0.0.0-live-interop")
        }
    }

    private func pass(_ r: Receiver, seconds: TimeInterval = engineSeconds) async throws
        -> InboxReceiveEngine.PassResult {
        let engine = r.engine
        return try await bounded("pass", seconds: seconds, session: r.session) { try await engine.pass() }
    }

    // MARK: - fixture

    private static let fixture: [String: [UInt8]] = {
        var big = [UInt8](repeating: 0, count: 450_000)   // > 2 frames of 192 KiB
        for i in big.indices { big[i] = UInt8(truncatingIfNeeded: (i &* 2_654_435_761) >> 13) }
        return [
            "payload/nested/deep/r\u{00E9}sum\u{00E9}-\u{6587}\u{4EF6}.txt": Array("h\u{00E9}llo".utf8),
            "payload/nested/empty.bin": [],
            "payload/big.bin": big,
            "lone.txt": Array("lone file".utf8),
        ]
    }()

    /// The exact receive-root listing a committed delivery leaves: the fixture,
    /// its directories, and the engine's (empty) staging parent.
    private static let committedListing = [
        ".relayium-incoming", "lone.txt", "payload", "payload/big.bin", "payload/nested",
        "payload/nested/deep", "payload/nested/deep/r\u{00E9}sum\u{00E9}-\u{6587}\u{4EF6}.txt",
        "payload/nested/empty.bin",
    ]

    private func writeFixture(_ src: URL) throws {
        for (rel, bytes) in Self.fixture {
            let url = src.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(bytes).write(to: url)
        }
    }

    private func listing(_ root: URL) -> [String] {
        ((try? FileManager.default.subpathsOfDirectory(atPath: root.path)) ?? []).sorted()
    }

    private func send(_ w: World) async throws -> String {
        let src = w.run.dir.appendingPathComponent("src")
        try writeFixture(src)
        let (code, out, err) = try await cli(w, ["inbox", "send", "--to", try XCTUnwrap(w.meta["receiverDeviceId"]),
                                                 "--json", "--config-dir", try XCTUnwrap(w.meta["senderConfigDir"]),
                                                 src.appendingPathComponent("payload").path,
                                                 src.appendingPathComponent("lone.txt").path], name: "cli-send")
        XCTAssertEqual(code, 0, "inbox send failed:\n\(out)\n\(err)")
        let doc = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any])
        XCTAssertEqual(doc["state"] as? String, "queued", "inbox send: \(out)")
        let taskID = try XCTUnwrap(doc["taskId"] as? String)
        XCTAssertFalse(taskID.isEmpty)
        return taskID
    }

    /// A separate CLI process reads the task from central on its own.
    private func sentTask(_ w: World, _ taskID: String, name: String) async throws -> [String: Any] {
        let (code, out, err) = try await cli(w, ["inbox", "sent", taskID, "--json",
                                                 "--config-dir", try XCTUnwrap(w.meta["senderConfigDir"])], name: name)
        XCTAssertEqual(code, 0, "inbox sent failed:\n\(out)\n\(err)")
        let doc = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any])
        return try XCTUnwrap(doc["task"] as? [String: Any])
    }

    private func helperExit(_ w: World) async throws -> [String: Any] {
        let outcome = await w.helper.stop()
        XCTAssertEqual(outcome, .exited(0), "the helper must end on the cooperative stdin close:\n\(w.helper.stderr)")
        let data = try Data(contentsOf: w.run.dir.appendingPathComponent("helper-exit.json"))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - S1S-1..4: the positive, exact tree

    func testLiveCLISendIsCommittedByTheNativeEngineAndTheCLIReadsSaved() async throws {
        let run = try makeRun()
        let w = try await startWorld(run, fault: "", withCLI: true)
        let r = try receiver(w)
        try await prepare(r)
        let taskID = try await send(w)

        let started = Date()
        let result = try await pass(r)
        print("LIVE-TIMING pass \(String(format: "%.1f", Date().timeIntervalSince(started))) s")
        XCTAssertEqual(result, .worked)
        XCTAssertEqual(r.receipts.count, 1, "saved must come from exactly one durable commit receipt")
        XCTAssertEqual(listing(r.root), Self.committedListing)
        for (rel, bytes) in Self.fixture {
            XCTAssertEqual(try? Data(contentsOf: r.root.appendingPathComponent(rel)), Data(bytes), rel)
        }

        let task = try await sentTask(w, taskID, name: "cli-sent")
        XCTAssertEqual(task["state"] as? String, "saved", "CLI independent status: \(task)")
        XCTAssertEqual(task["taskId"] as? String, taskID)

        let exit = try await helperExit(w)
        XCTAssertEqual(exit["exit"] as? String, "stdin-eof")
        XCTAssertEqual(exit["tamperedPatches"] as? Int, 0)
    }

    // MARK: - S1S-N1: tag corruption commits nothing

    func testCorruptedFinalFrameTagCommitsNothingAndTheCLIDoesNotReadSaved() async throws {
        let run = try makeRun()
        let w = try await startWorld(run, fault: "final-tag", withCLI: true)
        let r = try receiver(w)
        try await prepare(r)
        let taskID = try await send(w)

        let first = try await pass(r)
        XCTAssertEqual(first, .worked, "the delivery must be worked to a terminal report")
        XCTAssertEqual(r.receipts.count, 0, "no success receipt may exist")
        XCTAssertEqual(listing(r.root), [".relayium-incoming"], "nothing may be committed")

        let task = try await sentTask(w, taskID, name: "cli-sent")
        let state = task["state"] as? String
        XCTAssertTrue(state == "failed_retryable" || state == "failed", "state: \(task)")
        XCTAssertEqual(task["errorCode"] as? String, "verify_failed", "task: \(task)")

        // A second pass must not commit either.
        let second = try await pass(r)
        XCTAssertEqual(second, .idle)
        XCTAssertEqual(listing(r.root), [".relayium-incoming"])
        XCTAssertEqual(r.receipts.count, 0)

        let exit = try await helperExit(w)
        XCTAssertEqual(exit["tamperedPatches"] as? Int, 1, "the fault must have fired exactly once: \(exit)")
    }

    // MARK: - bounded harness paths

    func testAHelperThatExitsBeforeReadyFailsBoundedAndIsCleanedUp() async throws {
        let run = try makeRun()
        let started = Date()
        do {
            _ = try await startWorld(run, fault: "exit-before-ready", withCLI: false, readySeconds: 60)
            XCTFail("a helper that exited must not be reported ready")
        } catch let e as LiveError {
            XCTAssertEqual(e, .helperExitedBeforeReady(3))
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 60, "noticing an exit must not wait for the readiness deadline")
        let unreaped = await run.cleanup()
        XCTAssertEqual(unreaped, [])
        XCTAssertEqual(run.outcomes["helper"], .exited(3))
        XCTAssertFalse(FileManager.default.fileExists(atPath: run.dir.path))
    }

    func testAHelperStuckBeforeReadyIsKilledReapedAndCleanedUp() async throws {
        let run = try makeRun()
        let grace = Grace(afterStdinClose: 1, afterTerm: 1, afterKill: 5)
        do {
            _ = try await startWorld(run, fault: "stuck-before-ready", withCLI: false, readySeconds: 3,
                                     helperGrace: grace)
            XCTFail("a helper that never published ready.json must not be reported ready")
        } catch let e as LiveError {
            XCTAssertEqual(e, .helperNotReady(seconds: 3))
        }
        let started = Date()
        let unreaped = await run.cleanup()
        XCTAssertEqual(unreaped, [])
        // It ignores stdin EOF and SIGTERM by construction, so only SIGKILL can
        // have ended it — which is the escalation this case exists to prove.
        XCTAssertEqual(run.outcomes["helper"], .killed(SIGKILL))
        XCTAssertLessThan(Date().timeIntervalSince(started), 1 + 1 + 5 + 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: run.dir.path))
    }

    func testAHungCentralRequestIsTornDownByTheDeadline() async throws {
        let run = try makeRun()
        let w = try await startWorld(run, fault: "hang-pending", withCLI: false)
        let r = try receiver(w)
        try await prepare(r)

        let started = Date()
        do {
            _ = try await pass(r, seconds: 3)
            XCTFail("a pass whose pending request never answers must hit the deadline")
        } catch let e as LiveError {
            XCTAssertEqual(e, .deadline("pass"))
        }
        let elapsed = Date().timeIntervalSince(started)
        print("LIVE-TIMING hung-pass \(String(format: "%.1f", elapsed)) s")
        XCTAssertLessThan(elapsed, 3 + 5, "the call must end promptly once its transport is torn down")

        // Central saw the CLIENT abandon the held request: the deadline really
        // reached the underlying connection rather than leaving it running.
        let marker = run.dir.appendingPathComponent("pending-abandoned")
        let end = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(atPath: marker.path), Date() < end {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path),
                      "central never observed the request being abandoned")

        let exit = try await helperExit(w)
        XCTAssertGreaterThanOrEqual(exit["abandonedPending"] as? Int ?? 0, 1)
        let unreaped = await run.cleanup()
        XCTAssertEqual(unreaped, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: run.dir.path))
    }
}
