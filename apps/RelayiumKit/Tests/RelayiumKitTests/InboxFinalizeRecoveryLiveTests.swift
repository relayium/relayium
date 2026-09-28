import Darwin
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Device Inbox finalize recovery, BY EXECUTION against a REAL central.
///
/// The Go helper `server/internal/inboxlive` (`TestSwiftLiveFinalizeCentral`)
/// hosts account.Service on a file-backed SQLite database with a DiskStore and a
/// really enrolled receiver. This process drives the product
/// `InboxSendCoordinator` → `CloudUploader.resumeRecoverable` →
/// `HTTPResumableTransport` over a real protected `PendingUploadStore`. Faults
/// run, withhold or drop central's REAL handlers; every number asserted is read
/// from central's database and request middleware, never from the client.
///
/// `RELAYIUM_SWIFT_INTEROP`: `1` = run and never skip (a missing prerequisite
/// is a failure); anything else = skip, as `InboxCLISenderLiveInteropTests`.
///
/// `@MainActor` for the reason `InboxCLISenderLiveInteropTests` records: an
/// assertion raised off the main actor late in an async test can be lost.
@MainActor
final class InboxFinalizeRecoveryLiveTests: XCTestCase {

    private static let mode = ProcessInfo.processInfo.environment["RELAYIUM_SWIFT_INTEROP"]
    private static var helperBinary: URL?

    struct Central {
        let process: Process
        let stdin: Pipe
        let dir: URL
        let meta: [String: String]
        var url: URL { URL(string: meta["url"]!)! }
        var control: String { meta["control"]! }
        var token: String { meta["senderToken"]! }
        var account: String { meta["accountId"]! }
    }

    private var centrals: [Central] = []
    private var sessions: [URLSession] = []
    private var children: [Process] = []
    private var dirs: [URL] = []
    private var evidence: [String: Any] = [:]

    override func tearDown() async throws {
        if let out = ProcessInfo.processInfo.environment["RELAYIUM_FINALIZE_EVIDENCE"], !evidence.isEmpty {
            let name = name.replacingOccurrences(of: "[^A-Za-z0-9]+", with: "-", options: .regularExpression)
            let data = try? JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
            try? data?.write(to: URL(fileURLWithPath: out).appendingPathComponent("\(name).json"))
        }
        sessions.forEach { $0.invalidateAndCancel() }
        for child in children where child.isRunning { kill(child.processIdentifier, SIGKILL) }
        for c in centrals {
            try? c.stdin.fileHandleForWriting.close()
            for _ in 0..<100 where c.process.isRunning { try? await Task.sleep(nanoseconds: 50_000_000) }
            if c.process.isRunning { kill(c.process.processIdentifier, SIGKILL) }
            // A race-instrumented central (GOFLAGS=-race) reports here; the
            // helper's own exit status is not otherwise observed.
            let log = Self.helperLog(c.dir.appendingPathComponent("helper.log"))
            XCTAssertFalse(log.contains("WARNING: DATA RACE"), "the live central reported a data race:\n\(log)")
        }
        for d in dirs { try? FileManager.default.removeItem(at: d) }
    }

    // MARK: - world

    private func tempDir(_ label: String) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-finalize-\(label)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        dirs.append(dir)
        return dir
    }

    private func goExecutable() -> URL? {
        var paths = ["/opt/homebrew/bin", "/usr/local/go/bin", "/usr/local/bin", "/opt/homebrew/opt/go/bin"]
        paths += (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        return paths.first { FileManager.default.isExecutableFile(atPath: $0 + "/go") }
            .map { URL(fileURLWithPath: $0 + "/go") }
    }

    private func helper() throws -> URL {
        if let built = Self.helperBinary { return built }
        guard let go = goExecutable() else {
            XCTFail("RELAYIUM_SWIFT_INTEROP=1 but no Go toolchain; a forced run never skips")
            throw CancellationError()
        }
        let out = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-finalize-helper-\(UUID().uuidString)")
        let p = Process()
        p.executableURL = go
        p.arguments = ["test", "-c", "-tags", "swiftinterop", "-o", out.path, "./internal/inboxlive/"]
        p.currentDirectoryURL = try RepoRoot.directory("server")
        var env = ProcessInfo.processInfo.environment
        env["GOWORK"] = "off"
        // The caller's flags are KEPT (a reviewer's `GOFLAGS=-race` must build
        // a race-instrumented central); read-only module resolution is added
        // unless the caller already chose a -mod mode.
        let flags = env["GOFLAGS"] ?? ""
        env["GOFLAGS"] = flags.split(separator: " ").contains { $0.hasPrefix("-mod=") }
            ? flags : (flags.isEmpty ? "-mod=readonly" : flags + " -mod=readonly")
        p.environment = env
        let started = Date()
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            XCTFail("go test -c inboxlive failed with \(p.terminationStatus)")
            throw CancellationError()
        }
        print("LIVE-TIMING go-test-c-inboxlive \(String(format: "%.1f", Date().timeIntervalSince(started))) s GOFLAGS=\(env["GOFLAGS"] ?? "")")
        Self.helperBinary = out
        return out
    }

    private func startCentral() async throws -> Central {
        guard Self.mode == "1" else { throw XCTSkip("RELAYIUM_SWIFT_INTEROP != 1") }  // nonlocalized: skip reason
        let exe = try helper()
        let dir = try tempDir("central")
        let p = Process()
        p.executableURL = exe
        p.arguments = ["-test.run", "^TestSwiftLiveFinalizeCentral$", "-test.count=1", "-test.timeout=320s"]
        var env = ProcessInfo.processInfo.environment
        env["RELAYIUM_SWIFT_FINALIZE_DIR"] = dir.path
        env["HOME"] = dir.path
        p.environment = env
        let stdin = Pipe()
        p.standardInput = stdin
        let log = dir.appendingPathComponent("helper.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        p.standardOutput = try FileHandle(forWritingTo: log)
        p.standardError = p.standardOutput
        try p.run()
        let ready = dir.appendingPathComponent("ready.json")
        let end = Date().addingTimeInterval(60)
        while !FileManager.default.fileExists(atPath: ready.path) {
            guard p.isRunning, Date() < end else {
                XCTFail("helper not ready: \(Self.helperLog(log))")
                throw CancellationError()
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let meta = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: String])
        let c = Central(process: p, stdin: stdin, dir: dir, meta: meta)
        centrals.append(c)
        return c
    }

    /// A helper's captured output; an unreadable log says so rather than
    /// reading as empty.
    private static func helperLog(_ url: URL) -> String {
        do { return try String(contentsOf: url, encoding: .utf8) }
        catch { return "<unreadable \(url.lastPathComponent): \(error)>" }
    }

    @discardableResult
    private func control(_ c: Central, _ method: String, _ path: String) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: c.control + path)!)
        req.httpMethod = method
        let (data, response) = try await URLSession.shared.data(for: req)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "control \(path)")
        guard !data.isEmpty else { return [:] }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private func counts(_ c: Central, other: Bool = false) async throws -> [String: Any] {
        try await control(c, "GET", other ? "/counts?as=other" : "/counts")
    }

    private func int(_ counts: [String: Any], _ key: String) -> Int { (counts[key] as? Int) ?? -1 }

    // MARK: - the sender, exactly as the app builds it

    /// A content-key store that survives a real process exit (the Keychain is
    /// unavailable to `swift test`). Test-only.
    final class FileKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        let dir: URL
        init(dir: URL) { self.dir = dir }
        func save(id: String, keyB64url: String) async throws {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(keyB64url.utf8).write(to: dir.appendingPathComponent(id), options: .atomic)
        }
        func key(for id: String) async throws -> String? {
            (try? Data(contentsOf: dir.appendingPathComponent(id))).flatMap { String(data: $0, encoding: .utf8) }
        }
        func remove(id: String) async throws { try? FileManager.default.removeItem(at: dir.appendingPathComponent(id)) }
    }

    struct Sender: @unchecked Sendable {
        let root: URL
        let keys: StoredLinkKeyStore
        var shared: URL { root.appendingPathComponent("PendingUploads") }
        /// A NEW store instance each time: what a relaunch sees.
        var store: PendingUploadStore { PendingUploadStore(root: shared).protectedDeviceStore() }
    }

    private func sender(keys: StoredLinkKeyStore? = nil) throws -> Sender {
        let root = try tempDir("sender")
        return Sender(root: root, keys: keys ?? FileKeyStore(dir: root.appendingPathComponent("keys")))
    }

    private static let fastPolicy: FinalizeRecoveryPolicy = {
        var p = FinalizeRecoveryPolicy()
        p.backoffStep = 0.05
        p.backoffMax = 0.2
        p.runningPollMin = 0.05
        p.runningPollMax = 0.2
        p.runningPollDefault = 0.1
        return p
    }()

    private func coordinator(_ c: Central, _ s: Sender, store: PendingUploadStore? = nil,
                             token: String? = nil) -> InboxSendCoordinator {
        let session = URLSession(configuration: .ephemeral)
        sessions.append(session)
        return InboxSendCoordinator(
            store: store ?? s.store, keys: s.keys,
            uploader: CloudUploader(transport: HTTPResumableTransport(baseURL: c.url, session: session)),
            sender: InboxSenderClient(baseURL: c.url, token: token ?? c.token, session: session),
            finalizePolicy: Self.fastPolicy)
    }

    private func target(_ c: Central) async throws -> PendingUploadTarget {
        let session = URLSession(configuration: .ephemeral)
        sessions.append(session)
        let rows = try await InboxSenderClient(baseURL: c.url, token: c.token, session: session).devices()
        let row = try XCTUnwrap(rows.first { $0.id == c.meta["receiverDeviceId"] })
        let t = try XCTUnwrap(InboxTargetEligibility.target(for: row), "receiver is not a legal target")
        return PendingUploadTarget(t)
    }

    private func payload(_ size: Int, seed: Int = 7) -> [UInt8] {
        (0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ seed) }
    }

    private func stage(_ c: Central, _ s: Sender, sizes: [Int] = [200_000]) async throws -> PendingUploadPlan {
        let sources = sizes.enumerated().map { DataSource(name: "f\($0.offset).bin", bytes: payload($0.element)) }
        let plan = try s.store.prepare(sources: sources, accountId: c.account, burnAfterRead: false,
                                       ttl: UploadPurpose.deviceTaskTTLSeconds, target: try await target(c))
        try await s.keys.save(id: plan.jobId, keyB64url: encodeStoreKey(generateStoreKey()))
        return plan
    }

    private enum Outcome: Equatable {
        case delivered(created: Bool)
        case failed(InboxSendFailure)
        case cancelled
        case other(String)
    }

    private func deliver(_ c: Central, _ s: Sender, _ jobId: String, token: String? = nil) async -> Outcome {
        let store = s.store
        guard let plan = store.ownedDevicePlan(jobId: jobId) else { return .other("no plan on disk") }
        do {
            let r = try await coordinator(c, s, store: store, token: token).deliver(plan, token: token ?? c.token)
            return .delivered(created: r.created)
        } catch let f as InboxSendFailure {
            return .failed(f)
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .other("\(error)")
        }
    }

    /// One delivery's whole financial footprint on central.
    private func assertExactlyOnce(_ c: Central, ciphertext: Int, tasks: Int = 1,
                                   file: StaticString = #filePath, line: UInt = #line) async throws {
        let n = try await counts(c)
        evidence["final"] = n
        XCTAssertEqual(int(n, "hitsInit"), 1, "upload sessions opened", file: file, line: line)
        XCTAssertEqual(int(n, "patchBodyBytes"), ciphertext, "bytes PATCHed", file: file, line: line)
        XCTAssertEqual(int(n, "storedFiles"), 1, "stored objects", file: file, line: line)
        XCTAssertEqual(int(n, "uploadEventRows"), 1, "daily-quota debits", file: file, line: line)
        XCTAssertEqual(int(n, "quotaBytes"), max(ciphertext, 65_536), "daily-quota bytes", file: file, line: line)
        XCTAssertEqual(int(n, "monthlyUploadBytes"), ciphertext, "monthly traffic", file: file, line: line)
        XCTAssertEqual(int(n, "inboxTasks"), tasks, "tasks", file: file, line: line)
        if tasks == 1 {
            XCTAssertEqual(n["taskStoredFileIds"] as? [String], n["storedFileIds"] as? [String],
                           "the task binds the one object", file: file, line: line)
        }
        let bodies = (n["finalizeBodies"] as? [String]) ?? []
        XCTAssertFalse(bodies.isEmpty, file: file, line: line)
        XCTAssertTrue(bodies.allSatisfy { $0.contains("\"recoverFinalized\":true") },
                      "a delivery finalize left without the recovery opt-in: \(bodies)", file: file, line: line)
    }

    private var oneFile: Int { cipherSizeFor([200_000]) }

    // MARK: - A1 / A3: lost answers

    /// A1: the first finalize answer is lost after central committed it. The
    /// bounded in-attempt retry reads the committed object back.
    func testLiveALostFinalizeAnswerIsRecoveredWithoutASecondObject() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await control(c, "POST", "/fault/drop-finalize?times=1")
        let outcome = await deliver(c, s, plan.jobId)
        evidence["attempt1"] = "\(outcome)"
        XCTAssertEqual(outcome, .delivered(created: true))
        try await assertExactlyOnce(c, ciphertext: oneFile)
        do { let v = int(try await counts(c), "hitsFinalize"); XCTAssertEqual(v, 2) }
    }

    /// A3: every answer of an attempt lost → honest unknown; Retry recovers. A
    /// variant also loses the Retry's answers → still unknown, still one upload.
    func testLiveEveryAnswerLostEndsUnknownAndRetryRecoversOnce() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await control(c, "POST", "/fault/drop-finalize?times=6")
        let first = await deliver(c, s, plan.jobId)
        XCTAssertEqual(first, .failed(.uploadOutcomeUnknown))
        do { let v = int(try await counts(c), "hitsFinalize"); XCTAssertEqual(v, 3) }
        let second = await deliver(c, s, plan.jobId)
        XCTAssertEqual(second, .failed(.uploadOutcomeUnknown))
        let third = await deliver(c, s, plan.jobId)
        evidence["attempts"] = ["\(first)", "\(second)", "\(third)"]
        XCTAssertEqual(third, .delivered(created: true))
        try await assertExactlyOnce(c, ciphertext: oneFile)
    }

    // MARK: - A2: a real process killed after central committed

    func testLiveProcessKilledAfterCentralCommittedRecoversOnce() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await control(c, "POST", "/fault/hold-finalize")
        let meta = s.root.appendingPathComponent("child.json")
        try JSONSerialization.data(withJSONObject: ["root": s.root.path, "url": c.meta["url"]!,
                                                    "token": c.token, "job": plan.jobId]).write(to: meta)
        let bundle = Bundle(for: Self.self).bundleURL
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        child.arguments = ["xctest", "-XCTest",
                           "RelayiumKitTests.InboxFinalizeRecoveryChildProcess/testChildProcessAttempt",
                           bundle.path]
        var env = ProcessInfo.processInfo.environment
        env["RELAYIUM_FINALIZE_CHILD_META"] = meta.path
        env.removeValue(forKey: "RELAYIUM_FINALIZE_EVIDENCE")
        child.environment = env
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        children.append(child)
        let childPID = child.processIdentifier

        let end = Date().addingTimeInterval(120)
        while int(try await counts(c), "storedFiles") < 1 {
            guard Date() < end, child.isRunning else { return XCTFail("the child never reached a committed finalize") }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let onDiskBeforeKill = s.store.ownedDevicePlan(jobId: plan.jobId)
        XCTAssertEqual(onDiskBeforeKill?.deviceSessionState, onDiskBeforeKill?.uploadId.map { .finalizing($0) },
                       "the phase was not durable before the request")
        kill(childPID, SIGKILL)
        child.waitUntilExit()
        XCTAssertEqual(child.terminationReason, .uncaughtSignal)
        try await control(c, "POST", "/release")

        let retry = await deliver(c, s, plan.jobId)               // THIS process, new store instance
        evidence["childPID"] = Int(childPID)
        evidence["retry"] = "\(retry)"
        XCTAssertEqual(retry, .delivered(created: true))
        try await assertExactlyOnce(c, ciphertext: oneFile)
    }

    // MARK: - A4 / A5: a server without recovery

    func testLivePreRecoveryServerStaysUnknownThroughRecordPurgeAndNeverReuploads() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await control(c, "POST", "/fault/pre-recovery")
        try await control(c, "POST", "/fault/drop-finalize?times=1")
        var outcomes: [String] = []
        let first = await deliver(c, s, plan.jobId)                 // answer lost, then text 409
        outcomes.append("\(first)")
        XCTAssertEqual(first, .failed(.uploadOutcomeUnknown))
        let second = await deliver(c, s, plan.jobId)
        outcomes.append("\(second)")
        XCTAssertEqual(second, .failed(.uploadOutcomeUnknown))
        try await control(c, "POST", "/clock?advance=7300")          // past the object's expiry
        try await control(c, "POST", "/gc")                          // object and record collected
        let third = await deliver(c, s, plan.jobId)                 // 404 now
        outcomes.append("\(third)")
        XCTAssertEqual(third, .failed(.uploadOutcomeUnknown))
        evidence["outcomes"] = outcomes
        let n = try await counts(c)
        evidence["final"] = n
        XCTAssertEqual(int(n, "hitsInit"), 1, "a pre-recovery server's uncertainty caused a second upload")
        XCTAssertEqual(int(n, "patchBodyBytes"), oneFile)
        XCTAssertEqual(int(n, "hitsCreate"), 0)
        XCTAssertNotNil(s.store.ownedDevicePlan(jobId: plan.jobId), "the unknown delivery was not retained")
    }

    // MARK: - A6 / A7 / A8: terminal answers

    private func terminalCase(_ c: Central, _ s: Sender, _ plan: PendingUploadPlan,
                              expect: InboxUploadUnavailable) async throws {
        let outcome = await deliver(c, s, plan.jobId)
        evidence["terminal"] = "\(outcome)"
        XCTAssertEqual(outcome, .failed(.uploadUnavailable(expect)))
        let before = try await counts(c)
        let again = await deliver(c, s, plan.jobId)
        XCTAssertEqual(again, .failed(.uploadUnavailable(expect)))
        let after = try await counts(c)
        evidence["final"] = after
        for key in ["hitsInit", "hitsPatch", "hitsFinalize", "hitsStatus", "hitsCreate"] {
            XCTAssertEqual(int(after, key), int(before, key), "a terminal job sent \(key)")
        }
        XCTAssertEqual(int(after, "hitsInit"), 1)
        XCTAssertEqual(int(after, "hitsCreate"), 0)
        let kept = try XCTUnwrap(s.store.ownedDevicePlan(jobId: plan.jobId))
        XCTAssertNotNil(kept.terminalOutcome)
        XCTAssertNotNil(kept.uploadId, "the terminal record dropped its session")
    }

    func testLiveAnExpiredObjectIsTerminalAndNothingIsSentAgain() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await control(c, "POST", "/fault/drop-finalize?times=3")
        let first = await deliver(c, s, plan.jobId)
        XCTAssertEqual(first, .failed(.uploadOutcomeUnknown))
        try await control(c, "POST", "/clock?advance=7300")          // past expiry; no GC yet
        try await terminalCase(c, s, plan, expect: .expired)
    }

    func testLiveARemovedObjectIsTerminal() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await control(c, "POST", "/fault/drop-finalize?times=3")
        _ = await deliver(c, s, plan.jobId)
        let listed = try await counts(c)
        let stored = try XCTUnwrap(listed["storedFileIds"] as? [String]).first
        try await control(c, "POST", "/remove?id=\(try XCTUnwrap(stored))")
        try await terminalCase(c, s, plan, expect: .removed)
    }

    /// A finalize whose request never reached central (connection dropped
    /// before central saw it) on EVERY try of one attempt. The fault is armed
    /// once, before the attempt, and retired only after the attempt has
    /// returned — no polling, no per-request re-arming, no assumption about
    /// how many requests the attempt makes.
    private func finalizeNeverArrives(_ c: Central, _ s: Sender, _ plan: PendingUploadPlan) async throws {
        try await control(c, "POST", "/fault/lose-all-finalize")
        let first = await deliver(c, s, plan.jobId)
        let report = try await control(c, "POST", "/fault/restore-finalize")
        let n = try await counts(c)
        evidence["neverArrived"] = report
        evidence["neverArrivedAttempt"] = "\(first)"
        XCTAssertEqual(first, .failed(.uploadOutcomeUnknown))
        let intercepted = (report["intercepted"] as? Int) ?? -1
        XCTAssertGreaterThanOrEqual(intercepted, 1, "no finalize reached the fault")
        XCTAssertEqual(intercepted, int(n, "hitsFinalize"), "a finalize escaped the fault")
        XCTAssertEqual(report["doneSessions"] as? Int, 0, "central finalized the session")
        XCTAssertEqual(report["storedFiles"] as? Int, 0)
        XCTAssertEqual(report["inboxTasks"] as? Int, 0)
        XCTAssertEqual(int(n, "storedFiles"), 0)
    }

    /// R1, stated as a test: the request never arrived, then central reaped the
    /// idle session and deleted its row. Recovery can only answer 404, which
    /// cannot prove no object exists, so the delivery stays unconfirmed and
    /// retained — and is never uploaded a second time.
    func testLiveAFinalizeThatNeverArrivedThenReapedStaysUnknownAndIsNeverReuploaded() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await finalizeNeverArrives(c, s, plan)
        try await control(c, "POST", "/clock?advance=3700")
        try await control(c, "POST", "/gc")
        let retry = await deliver(c, s, plan.jobId)
        evidence["retry"] = "\(retry)"
        XCTAssertEqual(retry, .failed(.uploadOutcomeUnknown))
        let n = try await counts(c)
        evidence["final"] = n
        XCTAssertEqual(int(n, "hitsInit"), 1)
        XCTAssertEqual(int(n, "storedFiles"), 0)
        XCTAssertEqual(int(n, "uploadEventRows"), 0)
        XCTAssertNotNil(s.store.ownedDevicePlan(jobId: plan.jobId))
    }

    /// A8: the same, but the reaper cannot read the blob back (an unreachable
    /// node) and records the session UNRESOLVED: recovery answers `failed`,
    /// which is terminal.
    func testLiveAnUnresolvedReapedSessionIsTerminalFailedAndNotReuploaded() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await finalizeNeverArrives(c, s, plan)
        try await control(c, "POST", "/fault/blobs-unreadable?on=1")
        try await control(c, "POST", "/clock?advance=3700")
        try await control(c, "POST", "/gc")
        try await control(c, "POST", "/fault/blobs-unreadable?on=0")
        try await terminalCase(c, s, plan, expect: .notCompleted)
    }

    // MARK: - A9: cancellation after central committed

    func testLiveCancelledWhileCentralHoldsTheCommittedAnswerRecoversOnce() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        try await control(c, "POST", "/fault/hold-finalize")
        let attempt = Task { await self.deliver(c, s, plan.jobId) }
        let end = Date().addingTimeInterval(60)
        while int(try await counts(c), "storedFiles") < 1 {
            guard Date() < end else { return XCTFail("the finalize never committed") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        attempt.cancel()
        let first = await attempt.value
        XCTAssertEqual(first, .cancelled)
        // The attempt has returned, so it can send nothing more; releasing the
        // held answer only drops that connection.
        let posts = int(try await counts(c), "hitsFinalize")
        try await control(c, "POST", "/release")
        do { let v = int(try await counts(c), "hitsFinalize"); XCTAssertEqual(v, posts, "a request left after cancellation") }
        let retry = await deliver(c, s, plan.jobId)
        evidence["attempts"] = ["\(first)", "\(retry)"]
        XCTAssertEqual(retry, .delivered(created: true))
        try await assertExactlyOnce(c, ciphertext: oneFile)
    }

    // MARK: - A10 / A11: local persistence failures

    func testLivePhaseAndObjectRecordWriteFailuresNeverCauseASecondUpload() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)

        let failingPhase = s.store
        failingPhase.writeFailureInjection = { $0 == .finalizing }
        var outcome: Outcome
        do {
            _ = try await coordinator(c, s, store: failingPhase)
                .deliver(try XCTUnwrap(failingPhase.ownedDevicePlan(jobId: plan.jobId)), token: c.token)
            outcome = .delivered(created: true)
        } catch { outcome = .failed(error as? InboxSendFailure ?? .uploadFailed) }
        XCTAssertEqual(outcome, .failed(.recoveryStateWriteFailed))
        do { let v = int(try await counts(c), "hitsFinalize"); XCTAssertEqual(v, 0, "a finalize left without its phase") }

        let failingRecord = s.store
        failingRecord.writeFailureInjection = { $0 == .finalized }
        do {
            _ = try await coordinator(c, s, store: failingRecord)
                .deliver(try XCTUnwrap(failingRecord.ownedDevicePlan(jobId: plan.jobId)), token: c.token)
            outcome = .delivered(created: true)
        } catch { outcome = .failed(error as? InboxSendFailure ?? .uploadFailed) }
        XCTAssertEqual(outcome, .failed(.recoveryStateWriteFailed), "a committed object was reported as an upload failure")
        do { let v = int(try await counts(c), "storedFiles"); XCTAssertEqual(v, 1) }
        XCTAssertNotNil(s.store.ownedDevicePlan(jobId: plan.jobId))

        let retry = await deliver(c, s, plan.jobId)
        evidence["retry"] = "\(retry)"
        XCTAssertEqual(retry, .delivered(created: true))
        try await assertExactlyOnce(c, ciphertext: oneFile)
    }

    // MARK: - A13: another account's bearer

    func testLiveAForeignAccountsBearerUploadsNothingOnEitherAccount() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await stage(c, s)
        let outcome = await deliver(c, s, plan.jobId, token: c.meta["otherToken"]!)
        XCTAssertEqual(outcome, .failed(.targetMissing))
        let mine = try await counts(c)
        let theirs = try await counts(c, other: true)
        evidence["mine"] = mine
        evidence["theirs"] = theirs
        XCTAssertEqual(int(mine, "hitsInit"), 0)
        XCTAssertEqual(int(mine, "storedFiles"), 0)
        XCTAssertEqual(int(theirs, "storedFiles"), 0)
        XCTAssertEqual(int(theirs, "uploadEventRows"), 0)
        XCTAssertNotNil(s.store.ownedDevicePlan(jobId: plan.jobId))
    }

    // MARK: - A14: a delivery an earlier build finalized

    /// What 1.4.3 leaves behind: a v2 plan in the SHARED root with a session
    /// and no phase, whose finalize (body-less, as that build sends it)
    /// committed with its answer lost.
    private func earlierBuildFinalized(_ c: Central, _ s: Sender, dropAnswer: Bool,
                                       sendFinalize: Bool = true) async throws -> PendingUploadPlan {
        let staging = PendingUploadStore(root: s.root.appendingPathComponent("elsewhere")).protectedDeviceStore()
        var plan = try staging.prepare(sources: [DataSource(name: "f0.bin", bytes: payload(200_000))],
                                       accountId: c.account, burnAfterRead: false,
                                       ttl: UploadPurpose.deviceTaskTTLSeconds, target: try await target(c))
        let key = generateStoreKey()
        try await s.keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        let session = URLSession(configuration: .ephemeral)
        sessions.append(session)
        let old = HTTPResumableTransport(baseURL: c.url, session: session)
        // The earlier build's own upload: the share path's `resume`, which it
        // used for deliveries, with its plain finalize.
        if dropAnswer { try await control(c, "POST", "/fault/drop-finalize?times=1") }
        _ = try? await CloudUploader(transport: old).resume(
            sources: try staging.sources(for: plan), key: key, uploadId: nil, uploadChunkSize: nil,
            purpose: .deviceTask, manifest: try InboxSendManifest.sealed(for: plan), burnAfterRead: false,
            ttl: plan.ttl, token: c.token,
            onUploadSession: { id, chunk in plan = try staging.setUploadSession(id: id, chunkSize: chunk, for: plan) },
            onProgress: { _, _ in })
        // Move it where that build keeps deliveries, without the phase fields
        // it never wrote.
        try FileManager.default.createDirectory(at: s.shared, withIntermediateDirectories: true)
        let destination = s.shared.appendingPathComponent(plan.jobId)
        try FileManager.default.moveItem(at: staging.jobURL(for: plan.jobId), to: destination)
        let planURL = destination.appendingPathComponent("plan.json")
        var json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: planURL)) as? [String: Any])
        json.removeValue(forKey: "sessionPhase")
        json.removeValue(forKey: "phaseUploadId")
        try JSONSerialization.data(withJSONObject: json).write(to: planURL, options: .atomic)
        return plan
    }

    func testLiveAnEarlierBuildsLostFinalizeIsAdoptedAndRecoveredNotReuploaded() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await earlierBuildFinalized(c, s, dropAnswer: true)
        do { let v = int(try await counts(c), "storedFiles"); XCTAssertEqual(v, 1) }
        let report = s.store.adoptLegacyDeliveries()
        XCTAssertEqual(report.moved, [plan.jobId])
        XCTAssertEqual(s.store.ownedDevicePlan(jobId: plan.jobId)?.deviceSessionState, .unproven(plan.uploadId!))
        let outcome = await deliver(c, s, plan.jobId)
        evidence["outcome"] = "\(outcome)"
        XCTAssertEqual(outcome, .delivered(created: true))
        let n = try await counts(c)
        evidence["final"] = n
        XCTAssertEqual(int(n, "hitsInit"), 1)
        XCTAssertEqual(int(n, "storedFiles"), 1)
        XCTAssertEqual(int(n, "uploadEventRows"), 1)
        XCTAssertEqual(int(n, "patchBodyBytes"), oneFile)
        XCTAssertEqual(n["taskStoredFileIds"] as? [String], n["storedFileIds"] as? [String])
    }

    func testLiveAnEarlierBuildsSessionWhoseRecordIsGoneStaysUnknownNeverReuploaded() async throws {
        let c = try await startCentral()
        let s = try sender()
        let plan = try await earlierBuildFinalized(c, s, dropAnswer: true)
        try await control(c, "POST", "/clock?advance=7300")
        try await control(c, "POST", "/gc")
        s.store.adoptLegacyDeliveries()
        let outcome = await deliver(c, s, plan.jobId)
        XCTAssertEqual(outcome, .failed(.uploadOutcomeUnknown))
        let n = try await counts(c)
        evidence["final"] = n
        XCTAssertEqual(int(n, "hitsInit"), 1, "an unproven session's 404 caused a re-init")
    }

    /// What an earlier build leaves when it uploaded `committed` of this
    /// delivery's ciphertext through its own transport and has not finalized:
    /// an OPEN session, and a v2 plan in the shared root with no phase.
    private func earlierBuildOpenSession(_ c: Central, _ s: Sender, committed: (Int) -> Int) async throws
        -> (plan: PendingUploadPlan, uploadId: String, total: Int) {
        let staging = PendingUploadStore(root: s.root.appendingPathComponent("elsewhere")).protectedDeviceStore()
        var plan = try staging.prepare(sources: [DataSource(name: "f0.bin", bytes: payload(200_000))],
                                       accountId: c.account, burnAfterRead: false,
                                       ttl: UploadPurpose.deviceTaskTTLSeconds, target: try await target(c))
        let key = generateStoreKey()
        try await s.keys.save(id: plan.jobId, keyB64url: encodeStoreKey(key))
        let session = URLSession(configuration: .ephemeral)
        sessions.append(session)
        let old = HTTPResumableTransport(baseURL: c.url, session: session)
        let sources = try staging.sources(for: plan)
        let header = try CloudUploader.manifestHeader(key: key, sources: sources,
                                                      manifest: try InboxSendManifest.sealed(for: plan))
        let (uploadId, chunk) = try await old.initUpload(header: header, purpose: .deviceTask, burnAfterRead: false,
                                                         ttl: plan.ttl, size: oneFile, token: c.token)
        plan = try staging.setUploadSession(id: uploadId, chunkSize: chunk, for: plan)
        let enc = ChunkEncryptor(key: key, sources: sources)
        var stream = Data()
        while let frame = try enc.next() { stream += frame }
        let n = committed(stream.count)
        _ = try await old.patchChunk(uploadId: uploadId, bytes: stream.prefix(n), from: 0, to: n,
                                     total: stream.count, token: c.token, onBytesSent: nil)
        try FileManager.default.createDirectory(at: s.shared, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: staging.jobURL(for: plan.jobId),
                                         to: s.shared.appendingPathComponent(plan.jobId))
        let planURL = s.shared.appendingPathComponent(plan.jobId).appendingPathComponent("plan.json")
        var json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: planURL)) as? [String: Any])
        json.removeValue(forKey: "sessionPhase")
        json.removeValue(forKey: "phaseUploadId")
        try JSONSerialization.data(withJSONObject: json).write(to: planURL, options: .atomic)
        XCTAssertEqual(s.store.adoptLegacyDeliveries().moved, [plan.jobId])
        XCTAssertEqual(s.store.ownedDevicePlan(jobId: plan.jobId)?.deviceSessionState, .unproven(uploadId))
        return (plan, uploadId, stream.count)
    }

    private func earlierFinalizeReport(_ c: Central) async throws -> [String: Any] {
        try await control(c, "GET", "/fault/earlier-finalize-report")
    }

    /// Correction 1, partial: the sender reads an OPEN unproven session
    /// (status 200, half the bytes), then an earlier build's finalize of it
    /// completes — barrier: its response has been read — before the sender's
    /// continuation PATCH reaches central. The continuation fails; the session
    /// stays UNPROVEN (never promoted); the retry's 404 recovers the object the
    /// earlier finalize made and never opens a session.
    func testLiveAnEarlierFinalizeCommittingDuringAnUnprovenContinuationIsRecoveredNeverReinit() async throws {
        let c = try await startCentral()
        let s = try sender()
        let (plan, uploadId, total) = try await earlierBuildOpenSession(c, s) { $0 / 2 }
        try await control(c, "POST", "/fault/earlier-finalize-before?upload=\(uploadId)&on=patch")

        let first = await deliver(c, s, plan.jobId)
        let report = try await earlierFinalizeReport(c)
        evidence["attempt1"] = "\(first)"
        evidence["earlierFinalize"] = report
        XCTAssertEqual(report["fired"] as? Bool, true, "the interleaving was never reached")
        XCTAssertEqual(report["triggeredBy"] as? String, "PATCH /api/uploads/\(uploadId)")
        let before = try XCTUnwrap(report["sessionBefore"] as? [String: Any])
        XCTAssertEqual(before["done"] as? Int, 0, "the session was not open when the sender continued it")
        XCTAssertEqual(before["received"] as? Int, total / 2)
        XCTAssertEqual(report["earlierStatus"] as? Int, 200, "the earlier finalize did not commit")
        XCTAssertEqual((report["sessionAfter"] as? [String: Any])?["done"] as? Int, 1)
        XCTAssertEqual(first, .failed(.uploadFailed))
        XCTAssertEqual(s.store.ownedDevicePlan(jobId: plan.jobId)?.deviceSessionState, .unproven(uploadId),
                       "an unproven session was promoted")

        let retry = await deliver(c, s, plan.jobId)
        evidence["retry"] = "\(retry)"
        XCTAssertEqual(retry, .delivered(created: true))
        let n = try await counts(c)
        evidence["final"] = n
        XCTAssertEqual(int(n, "hitsInit"), 1, "a session was opened after an earlier finalize may have committed")
        XCTAssertEqual(int(n, "storedFiles"), 1)
        XCTAssertEqual(int(n, "uploadEventRows"), 1)
        XCTAssertEqual(n["taskStoredFileIds"] as? [String], n["storedFileIds"] as? [String])
        // R4, recorded rather than hidden: central finalized what was committed.
        XCTAssertEqual(int(n, "storedFileBytes"), total / 2)
    }

    /// Correction 1, complete: the sender reads an OPEN unproven session with
    /// every byte (status 200, r == total), writes its phase, and an earlier
    /// build's finalize completes just before the sender's own finalize reaches
    /// central. The sender's opted-in finalize reads that object back. One object.
    func testLiveAnEarlierFinalizeWinningTheRaceWithTheSendersFinalizeIsRecovered() async throws {
        let c = try await startCentral()
        let s = try sender()
        let (plan, uploadId, total) = try await earlierBuildOpenSession(c, s) { $0 }
        try await control(c, "POST", "/fault/earlier-finalize-before?upload=\(uploadId)&on=finalize")

        let outcome = await deliver(c, s, plan.jobId)
        let report = try await earlierFinalizeReport(c)
        evidence["outcome"] = "\(outcome)"
        evidence["earlierFinalize"] = report
        XCTAssertEqual(report["fired"] as? Bool, true, "the interleaving was never reached")
        XCTAssertEqual(report["triggeredBy"] as? String, "POST /api/uploads/\(uploadId)/finalize")
        let before = try XCTUnwrap(report["sessionBefore"] as? [String: Any])
        XCTAssertEqual(before["done"] as? Int, 0)
        XCTAssertEqual(before["received"] as? Int, total)
        XCTAssertEqual(report["earlierStatus"] as? Int, 200)
        XCTAssertEqual(outcome, .delivered(created: true))
        let n = try await counts(c)
        evidence["final"] = n
        XCTAssertEqual(int(n, "hitsInit"), 1)
        XCTAssertEqual(int(n, "hitsPatch"), 1, "a marked-or-complete session was PATCHed")
        XCTAssertEqual(int(n, "storedFiles"), 1)
        XCTAssertEqual(int(n, "storedFileBytes"), total)
        XCTAssertEqual(int(n, "uploadEventRows"), 1)
        XCTAssertEqual(n["taskStoredFileIds"] as? [String], n["storedFileIds"] as? [String])
        let bodies = (n["finalizeBodies"] as? [String]) ?? []
        XCTAssertEqual(bodies.count, 1, "the sender sent more than its one finalize")
        XCTAssertTrue(bodies.allSatisfy { $0.contains("recoverFinalized") })
    }

    // MARK: - A16 / A17: manifests and concurrency

    func testLiveMixedAndAllEmptyManifestsAreUploadedAndCountedOnce() async throws {
        for sizes in [[0, 70_000, 0], [0, 0]] {
            let c = try await startCentral()
            let s = try sender()
            let plan = try await stage(c, s, sizes: sizes)
            try await control(c, "POST", "/fault/drop-finalize?times=1")
            let outcome = await deliver(c, s, plan.jobId)
            XCTAssertEqual(outcome, .delivered(created: true), "\(sizes)")
            try await assertExactlyOnce(c, ciphertext: cipherSizeFor(sizes))
            evidence["\(sizes)"] = try await counts(c)
        }
    }

    func testLiveTwoConcurrentDeliveriesEachUploadOnceWhenOneAnswerIsLost() async throws {
        let c = try await startCentral()
        let s = try sender()
        let a = try await stage(c, s, sizes: [120_000])
        let b = try await stage(c, s, sizes: [90_000])
        try await control(c, "POST", "/fault/drop-finalize?times=1")
        async let ra = deliver(c, s, a.jobId)
        async let rb = deliver(c, s, b.jobId)
        let (oa, ob) = await (ra, rb)
        XCTAssertEqual(oa, .delivered(created: true))
        XCTAssertEqual(ob, .delivered(created: true))
        let n = try await counts(c)
        evidence["final"] = n
        XCTAssertEqual(int(n, "hitsInit"), 2)
        XCTAssertEqual(int(n, "storedFiles"), 2)
        XCTAssertEqual(int(n, "uploadEventRows"), 2)
        XCTAssertEqual(int(n, "inboxTasks"), 2)
        XCTAssertEqual(Set((n["taskStoredFileIds"] as? [String]) ?? []), Set((n["storedFileIds"] as? [String]) ?? []))
        XCTAssertEqual(int(n, "patchBodyBytes"), cipherSizeFor([120_000]) + cipherSizeFor([90_000]))
    }

    // MARK: - A19: the share path is unchanged

    func testLiveTheShareUploadStillSendsAPlainFinalize() async throws {
        let c = try await startCentral()
        let session = URLSession(configuration: .ephemeral)
        sessions.append(session)
        let uploader = CloudUploader(transport: HTTPResumableTransport(baseURL: c.url, session: session))
        let outcome = try await uploader.upload(sources: [DataSource(name: "s.bin", bytes: payload(10_000))],
                                                burnAfterRead: false, ttl: 3600, token: c.token,
                                                onProgress: { _, _ in })
        XCTAssertFalse(outcome.id.isEmpty)
        let n = try await counts(c)
        XCTAssertEqual(n["finalizeBodies"] as? [String], [""], "the share finalize request changed")
    }
}
