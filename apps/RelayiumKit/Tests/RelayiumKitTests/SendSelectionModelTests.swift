import XCTest
import Combine
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - doubles

/// An upload that starts and never finishes on its own, so `.uploading` is a
/// state a test can hold still and act against.
private final class HangingTransport: ResumableTransport, @unchecked Sendable {
    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        try await Task.sleep(nanoseconds: 60 * NSEC_PER_SEC)
        return ("u", 1 << 20)
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
        .committed(received: to)
    }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "u", expiresAt: 0)
    }
}

/// A thread-safe boolean, for flags an escaping `@Sendable` closure sets.
private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

/// A counter an escaping `@Sendable` closure bumps.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func bump() { lock.lock(); value += 1; lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}

/// `GET /api/config`, held open **per call** and released at a chosen moment, so
/// a response belonging to one account can be landed after another account has
/// signed in.
///
/// Per call, not one shared latch, because that distinction is the whole test:
/// account B issues its own fetch to the same public endpoint, and a single
/// latch answers both. A stub that did that would make "A's hint reached B" mean
/// "B's own legitimate answer arrived", and the assertion would be measuring the
/// stub rather than the model.
private final class ConfigStub: @unchecked Sendable {
    private let lock = NSLock()
    private var _calls = 0
    private var _holding = false
    private var _ignoresCancellation = false
    /// 1-based call index → the answer that call is released with. A call waits
    /// for its OWN index; another account's pending call keeps waiting.
    private var _released: [Int: ServerConfig] = [:]
    private var _result = ServerConfig(maxFileSize: 0)
    private var _failure: Error?

    var calls: Int { lock.lock(); defer { lock.unlock() }; return _calls }
    /// Same number, read where the test means "a fetch has started" rather than
    /// "a fetch happened".
    var entered: Int { calls }

    /// Hold every call until it is released by index.
    ///
    /// `ignoringCancellation` models a request that finishes what it started —
    /// the case where the response really does land after the account it
    /// belonged to is gone, so the generation and identity guards are what has
    /// to refuse it. With a cancellable hold, cancellation would answer first
    /// and those guards would never be reached.
    func hold(ignoringCancellation: Bool = false) {
        lock.lock()
        _holding = true
        _ignoresCancellation = ignoringCancellation
        _released = [:]
        lock.unlock()
    }

    func release(call index: Int = 1, _ config: ServerConfig) {
        lock.lock(); _released[index] = config; lock.unlock()
    }

    func answer(_ config: ServerConfig) {
        lock.lock(); _result = config; _holding = false; lock.unlock()
    }

    func fail(_ error: Error) {
        lock.lock(); _failure = error; _holding = false; lock.unlock()
    }

    private func answer(for index: Int) -> ServerConfig? {
        lock.lock(); defer { lock.unlock() }; return _released[index]
    }

    private func beginFetch() -> (index: Int, holding: Bool, ignoresCancellation: Bool) {
        lock.lock(); defer { lock.unlock() }
        _calls += 1
        return (_calls, _holding, _ignoresCancellation)
    }

    private func finalResult() -> (failure: Error?, result: ServerConfig) {
        lock.lock(); defer { lock.unlock() }
        return (_failure, _result)
    }

    func fetch() async throws -> ServerConfig {
        // Keep NSLock calls in synchronous helpers. Swift 6 rejects direct lock
        // operations from an async context because a suspension while locked
        // could strand the critical section; these helpers cannot suspend.
        let (index, holding, ignoresCancellation) = beginFetch()

        if holding {
            while true {
                if let released = answer(for: index) { return released }
                if ignoresCancellation {
                    // Not a cancellation point, so this call finishes even after
                    // the task that made it was cancelled.
                    await withUnsafeContinuation { continuation in
                        DispatchQueue.global().asyncAfter(deadline: .now() + 0.0003) {
                            continuation.resume()
                        }
                    }
                } else {
                    // Cancellation propagates through here, which is what makes
                    // the "a later account event cancels the older fetch" path
                    // real.
                    try await Task.sleep(nanoseconds: 300_000)
                }
            }
        }

        let (failure, result) = finalResult()
        if let failure { throw failure }
        return result
    }
}

/// Holds `load(index)` at a chosen index until the test lets it go, so
/// supersession can be driven at an exact moment rather than hoped for.
private final class LoaderGate: @unchecked Sendable {
    private let lock = NSLock()
    private var _reached: Set<Int> = []
    private var _released = false

    func has(reached index: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }; return _reached.contains(index)
    }

    func release() { lock.lock(); _released = true; lock.unlock() }

    private func markReached(_ index: Int) {
        lock.lock(); _reached.insert(index); lock.unlock()
    }

    private var isReleased: Bool {
        lock.lock(); defer { lock.unlock() }; return _released
    }

    func wait(at index: Int) async {
        markReached(index)
        while true {
            if isReleased { return }
            try? await Task.sleep(nanoseconds: 300_000)
        }
    }
}

private enum TestError: Error { case boom }

// MARK: - tests

/// Everything the send flow owns that is not a view: the security-scope
/// lifecycle, photo supersession, account isolation and the advisory config
/// fetch.
///
/// There is no `SendView` anywhere in this file, and that is the point. The
/// account work is app-scoped precisely so it keeps working when no send screen
/// is mounted, and a suite that could only exercise it through a view could not
/// prove that at all.
@MainActor
final class SendSelectionModelTests: XCTestCase {

    private var scratch: URL!
    private var importsRoot: URL!
    private var inbox: URL!
    private var access: SecurityScopedAccess!
    private var photos: PhotoStagingArea!
    private var upload: CloudUploadModel!
    private var config: ConfigStub!
    private var keys: InMemoryStoredLinkKeyStore!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("send-model-tests-\(UUID().uuidString)")
        importsRoot = scratch.appendingPathComponent("PhotoImports")
        inbox = scratch.appendingPathComponent("PhotoInbox")
        try FileManager.default.createDirectory(at: importsRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        access = SecurityScopedAccess()
        photos = PhotoStagingArea(root: importsRoot)
        keys = InMemoryStoredLinkKeyStore()
        upload = CloudUploadModel(uploader: CloudUploader(transport: HangingTransport()),
                                  keyStore: keys,
                                  origin: "https://relayium.com")
        config = ConfigStub()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    // MARK: helpers

    private func makeModel(
        expand: (([URL]) throws -> FileSelection)? = nil,
        enforcesReadyAccount: Bool = false
    ) -> SendSelectionModel {
        let store = SelectionStore(expand: expand ?? { urls in
            FileSelection(files: urls.map {
                SelectedFile(url: $0, relativePath: $0.lastPathComponent)
            }, emptyDirectories: [])
        })
        let stub = config!
        return SendSelectionModel(upload: upload,
                                  access: access,
                                  photos: photos,
                                  inbox: inbox,
                                  fetchConfig: { try await stub.fetch() },
                                  store: store,
                                  enforcesReadyAccount: enforcesReadyAccount)
    }

    /// A real file, because `CloudUploadModel.pick` reads sizes off disk when a
    /// size gate is on.
    private func fileURL(_ name: String, bytes: Int = 64) -> URL {
        let url = scratch.appendingPathComponent("files-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let file = url.appendingPathComponent(name)
        FileManager.default.createFile(atPath: file.path,
                                       contents: Data(repeating: 3, count: bytes))
        return file
    }

    private func candidate(_ name: String) throws -> PhotoCandidate {
        let provider = scratch.appendingPathComponent("provider-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: provider, withIntermediateDirectories: true)
        let file = provider.appendingPathComponent(name)
        try Data(repeating: 9, count: 16).write(to: file)
        return try PhotoInbox.take(file, in: inbox)
    }

    /// Batch directories that exist anywhere under this test's imports root.
    private func batchDirectoriesOnDisk() -> [String] {
        guard let launches = try? FileManager.default
            .contentsOfDirectory(at: importsRoot, includingPropertiesForKeys: nil) else { return [] }
        return launches.flatMap { launch in
            ((try? FileManager.default.contentsOfDirectory(atPath: launch.path)) ?? [])
        }.sorted()
    }

    private func inboxCandidatesOnDisk() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: inbox.path)) ?? []).sorted()
    }

    private func stagedNames() -> [String] {
        guard case let .picked(files) = upload.state else { return [] }
        return files.map(\.name)
    }

    private var expectedSummaryForOneFile: String { L10n.plural(.selectionFiles, 1) }

    private func readyState(_ id: String, retention: Int64) -> SessionState {
        .ready(user: NativeUser(id: id, email: "\(id)@b.co", displayName: id,
                                hasPassword: true, emailVerified: true,
                                linkedMethods: ["password"], onlyOwnNodes: false,
                                planId: "pro", subscriptionStatus: "active",
                                subscriptionEnd: 0, hasBilling: true,
                                scheduledPlanId: "", scheduledCycle: "",
                                billingCycle: "monthly"),
               usage: usage(retention: retention))
    }

    private func usage(retention: Int64) -> UsageResponse {
        UsageResponse(period: "202608", resetsAt: 0,
                      traffic: Meter(used: 0, cap: 0),
                      storage: Meter(used: 0, cap: 0),
                      plan: PlanInfo(id: "pro", name: "Pro", storageBytes: 0,
                                     trafficBytes: 0, retentionSecs: retention,
                                     priceMonthly: 0, priceYearly: 0, isTop: false,
                                     subscriptionStatus: "active", subscriptionEnd: 0,
                                     billingCycle: "monthly", scheduledPlanId: "",
                                     scheduledPlanName: "", scheduledCycle: ""))
    }

    /// Let the cooperative pool make progress without pinning the test to a
    /// wall-clock guess.
    private func settle(_ rounds: Int = 40) async {
        for _ in 0..<rounds {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    @discardableResult
    private func waitUntil(_ timeout: TimeInterval = 3,
                           _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 500_000)
        }
        return condition()
    }

    // MARK: - files and scopes

    /// The scope has to be held BEFORE anything enumerates a folder, or a
    /// directory listing inside a security-scoped container fails.
    func testTheScopeIsHeldWhileTheSelectionIsExpanded() {
        let held = NSMutableArray()
        let scopes = access!
        let m = makeModel(expand: { urls in
            held.addObjects(from: scopes.heldURLs.map(\.path))
            return FileSelection(files: urls.map {
                SelectedFile(url: $0, relativePath: $0.lastPathComponent)
            }, emptyDirectories: [])
        })
        let file = fileURL("a.txt")
        m.chooseFiles(.success([file]))

        XCTAssertEqual(held as! [String], [file.path],
                       "expansion must run inside the scope, not before it")
        XCTAssertEqual(access.heldURLs.map(\.path), [file.path],
                       "and it stays held for the life of the selection")
        XCTAssertEqual(m.summary, expectedSummaryForOneFile)
    }

    /// A refusal by the UPLOAD model (an oversized file) stays an upload
    /// failure, and the previous files must not be restorable — their access is
    /// already gone, so `reset()` returning to them would return to files the
    /// app can no longer open.
    func testAnUploadRefusalLeavesNoScopeAndNothingToReturnTo() {
        let m = makeModel()
        m.chooseFiles(.success([fileURL("first.txt")]))
        guard case .picked = upload.state else { return XCTFail("got \(upload.state)") }

        upload.maxFileSize = 1
        m.chooseFiles(.success([fileURL("huge.bin", bytes: 4096)]))

        guard case .failed = upload.state else { return XCTFail("got \(upload.state)") }
        XCTAssertTrue(access.heldURLs.isEmpty, "a refused selection must leave no scope held")
        upload.reset()
        XCTAssertEqual(upload.state, .idle, "the previous files must not be restorable")
        XCTAssertNil(m.summary)
    }

    /// A PREPARATION failure never reaches the upload model: nothing was ever
    /// picked, so `.failed` there would offer a "Try again" that retries
    /// nothing. It is the parent's `selectionError`, and it is also the path
    /// that proves the forwarded observation is real.
    func testAFailedExpansionSetsSelectionErrorAndLeavesTheUploadModelUntouched() {
        let m = makeModel(expand: { _ in throw FileSelectionError.noFiles })
        m.chooseFiles(.success([fileURL("a.txt")]))
        XCTAssertEqual(m.selectionError,
                       ErrorCopy.message(for: FileSelectionError.noFiles))
        XCTAssertEqual(upload.state, .idle, "a preparation failure is not an upload failure")
        XCTAssertTrue(access.heldURLs.isEmpty)
        XCTAssertNil(m.summary)
    }

    /// A picker failure is likewise a preparation failure, and it does not
    /// invent a selection change.
    func testAPickerFailureIsReportedWithoutTouchingTheUploadModel() {
        let m = makeModel()
        m.chooseFiles(.failure(TestError.boom))
        XCTAssertEqual(m.selectionError, ErrorCopy.message(for: TestError.boom))
        XCTAssertEqual(upload.state, .idle)
    }

    func testChoosingFilesWhileUploadingStartsNoScopeAtAll() {
        let m = makeModel()
        m.chooseFiles(.success([fileURL("a.txt")]))
        upload.start(token: "rlm_A")
        guard case .uploading = upload.state else { return XCTFail("got \(upload.state)") }
        let beforePaths = access.heldURLs.map(\.path)

        m.chooseFiles(.success([fileURL("b.txt")]))

        XCTAssertEqual(access.heldURLs.map(\.path), beforePaths,
                       "the bytes on the wire are the ones the current list describes")
        upload.cancel()
    }

    func testClearReleasesScopesAndDeletesTheStagedBatch() async {
        let m = makeModel()
        await m.importPhotos(count: 1) { _ in try self.candidate("A.HEIC") }
        XCTAssertEqual(batchDirectoriesOnDisk().count, 1)
        m.chooseFiles(.success([fileURL("a.txt")]))
        XCTAssertFalse(access.heldURLs.isEmpty)

        m.clear()

        XCTAssertTrue(access.heldURLs.isEmpty)
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertNil(m.summary)
        XCTAssertEqual(upload.state, .idle)
    }

    // MARK: - photo ordering, replacement and supersession

    func testAdoptedPhotosReachTheModelInSelectionOrder() async {
        let m = makeModel()
        await m.importPhotos(count: 3) { index in try self.candidate("IMG_\(index).HEIC") }
        XCTAssertEqual(stagedNames(), ["IMG_0.HEIC", "IMG_1.HEIC", "IMG_2.HEIC"])
        XCTAssertNil(m.importError)
        XCTAssertEqual(m.summary, L10n.plural(.selectionFiles, 3))
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty, "every candidate was moved, not copied")
    }

    /// The import replaced the selection at its START, so a failure part-way
    /// leaves nothing — including nothing of the FILE selection that was there
    /// before.
    func testAPartialPhotoFailureLeavesNoPriorFileSelectionRestorable() async {
        let m = makeModel()
        m.chooseFiles(.success([fileURL("a.txt")]))
        guard case .picked = upload.state else { return XCTFail("got \(upload.state)") }

        await m.importPhotos(count: 3) { index in
            if index == 2 { throw PhotoImportError.unusable }
            return try self.candidate("IMG_\(index).HEIC")
        }

        XCTAssertEqual(m.importError, L10n.t(.errorPhotoImportFailed))
        XCTAssertNil(m.summary)
        upload.reset()
        XCTAssertEqual(upload.state, .idle, "the previous files must not be restorable")
        XCTAssertTrue(access.heldURLs.isEmpty)
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
    }

    /// A move that fails is the other half of the same rule, and it is the one
    /// where the candidate has already been handed over.
    func testAFailedAdoptDiscardsTheCandidateAndTheBatch() async {
        let m = makeModel()
        await m.importPhotos(count: 2) { index in
            let c = try self.candidate("IMG_\(index).HEIC")
            // The batch directory disappears between the load and the move.
            if index == 1, let batch = self.batchDirectoriesOnDisk().first {
                let launches = try FileManager.default.contentsOfDirectory(
                    at: self.importsRoot, includingPropertiesForKeys: nil)
                for launch in launches {
                    try? FileManager.default.removeItem(
                        at: launch.appendingPathComponent(batch))
                }
            }
            return c
        }
        XCTAssertEqual(m.importError, L10n.t(.errorPhotoImportFailed))
        XCTAssertNil(m.summary)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty, "the failed move left it owning; it discarded")
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
    }

    /// Choosing files is a NEWER intent and must win. Refusing it because an
    /// import is running would make the app ignore the user.
    func testAFileChoiceOvertakesAnInFlightImport() async {
        let m = makeModel()
        let gate = LoaderGate()
        let importing = Task { await m.importPhotos(count: 2) { index in
            await gate.wait(at: index)
            return try self.candidate("IMG_\(index).HEIC")
        } }
        await waitUntil { gate.has(reached: 0) }

        m.chooseFiles(.success([fileURL("a.txt")]))     // supersedes, synchronously
        XCTAssertFalse(m.isImportingPhotos, "no newer import owns the flag")
        XCTAssertEqual(m.summary, expectedSummaryForOneFile)
        let latePublications = Counter()
        let subscription = m.objectWillChange.sink { _ in latePublications.bump() }

        gate.release()
        await importing.value

        XCTAssertEqual(m.summary, expectedSummaryForOneFile, "the older import must not repaint")
        XCTAssertEqual(latePublications.count, 0,
                       "a superseded import must not even republish the newer intent's state")
        XCTAssertFalse(m.isImportingPhotos)
        XCTAssertNil(m.importError, "a superseded import reports no failure")
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
        XCTAssertEqual(stagedNames(), ["a.txt"])
        subscription.cancel()
    }

    func testClearOvertakesAnInFlightImportAndLowersTheFlag() async {
        let m = makeModel()
        let gate = LoaderGate()
        let importing = Task { await m.importPhotos(count: 2) { index in
            await gate.wait(at: index)
            return try self.candidate("IMG_\(index).HEIC")
        } }
        await waitUntil { gate.has(reached: 0) }

        m.clear()
        XCTAssertFalse(m.isImportingPhotos)

        gate.release()
        await importing.value

        XCTAssertFalse(m.isImportingPhotos)
        XCTAssertNil(m.summary)
        XCTAssertNil(m.importError)
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
    }

    /// A defensive path the view never takes: `PhotoPickerChange.decide` turns
    /// an empty binding change into `.ignore`, because that change is the view's
    /// own reset.
    func testAZeroItemCallSupersedesAndClears() async {
        let m = makeModel()
        m.chooseFiles(.success([fileURL("a.txt")]))
        guard case .picked = upload.state else { return XCTFail("got \(upload.state)") }

        await m.importPhotos(count: 0) { _ in throw PhotoImportError.unusable }

        XCTAssertNil(m.summary)
        XCTAssertFalse(m.isImportingPhotos)
        XCTAssertNil(m.importError)
        XCTAssertEqual(upload.state, .idle)
        XCTAssertTrue(access.heldURLs.isEmpty)
    }

    /// A second import is not refused either; it supersedes, and the flag stays
    /// up because a newer import owns it.
    func testASecondImportSupersedesTheFirstWhileItIsStillLoading() async {
        let m = makeModel()
        let first = LoaderGate(), second = LoaderGate()
        let a = Task { await m.importPhotos(count: 1) { _ in
            await first.wait(at: 0); return try self.candidate("A.HEIC") } }
        await waitUntil { first.has(reached: 0) }
        let b = Task { await m.importPhotos(count: 1) { _ in
            await second.wait(at: 0); return try self.candidate("B.HEIC") } }
        await waitUntil { second.has(reached: 0) }
        XCTAssertTrue(m.isImportingPhotos)

        first.release(); await a.value
        XCTAssertTrue(m.isImportingPhotos, "the newer import still owns the flag")
        second.release(); await b.value

        XCTAssertFalse(m.isImportingPhotos)
        XCTAssertEqual(stagedNames(), ["B.HEIC"])
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
        XCTAssertEqual(batchDirectoriesOnDisk().count, 1, "the superseded batch is gone")
    }

    func testAnImportWhileUploadingIsRefusedOutright() async {
        let m = makeModel()
        m.chooseFiles(.success([fileURL("a.txt")]))
        upload.start(token: "rlm_A")
        guard case .uploading = upload.state else { return XCTFail("got \(upload.state)") }

        await m.importPhotos(count: 1) { _ in
            XCTFail("an in-flight upload is the one refusal")
            return try self.candidate("A.HEIC")
        }

        XCTAssertFalse(m.isImportingPhotos)
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        upload.cancel()
    }

    /// The photo path's half of the upload-refusal rule. It stays an UPLOAD
    /// failure — the model is the thing that refused — and the batch goes with
    /// it, the same way a refused file selection releases its scopes. Leaving
    /// the batch adopted would leave a summary line describing bytes nothing can
    /// now send.
    func testARefusedPhotoSelectionLeavesNoBatchAndNothingToReturnTo() async {
        let m = makeModel()
        upload.maxFileSize = 1

        await m.importPhotos(count: 1) { _ in try self.candidate("huge.mov") }

        guard case .failed = upload.state else { return XCTFail("got \(upload.state)") }
        XCTAssertNil(m.summary)
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
        upload.reset()
        XCTAssertEqual(upload.state, .idle, "a refused selection must not be restorable")
    }

    func testAPhotoImportReleasesTheFileScopes() async {
        let m = makeModel()
        m.chooseFiles(.success([fileURL("a.txt")]))
        XCTAssertFalse(access.heldURLs.isEmpty)

        await m.importPhotos(count: 1) { _ in try self.candidate("A.HEIC") }

        XCTAssertTrue(access.heldURLs.isEmpty,
                      "staged photos are the app's own files and take no sandbox extension")
        XCTAssertEqual(stagedNames(), ["A.HEIC"])
    }

    func testAFileSelectionDeletesTheStagedPhotoBatch() async {
        let m = makeModel()
        await m.importPhotos(count: 1) { _ in try self.candidate("A.HEIC") }
        XCTAssertEqual(batchDirectoriesOnDisk().count, 1)

        m.chooseFiles(.success([fileURL("a.txt")]))

        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertEqual(stagedNames(), ["a.txt"])
    }

    /// Exactly one sweep, at construction, for leftovers from a launch that
    /// crashed. A runtime sweep would race a provider callback still completing
    /// after cancellation and delete a directory about to be filled.
    func testTheInboxIsSweptOnlyAtConstruction() async throws {
        let leftover = inbox.appendingPathComponent("crashed-launch")
        try FileManager.default.createDirectory(at: leftover, withIntermediateDirectories: true)

        let m = makeModel()
        let swept = await waitUntil { !FileManager.default.fileExists(atPath: leftover.path) }
        XCTAssertTrue(swept, "construction sweeps the inbox once")

        // A candidate created afterwards must survive an import that supersedes,
        // because nothing sweeps the inbox again.
        let survivor = inbox.appendingPathComponent("later-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: survivor, withIntermediateDirectories: true)
        await m.importPhotos(count: 1) { _ in try self.candidate("A.HEIC") }
        m.clear()
        await settle(10)
        XCTAssertTrue(FileManager.default.fileExists(atPath: survivor.path),
                      "there is no runtime inbox sweep")
    }

    // MARK: - account isolation, driven by the session and no view

    /// File-importer and PhotosPicker callbacks can be delivered after the
    /// account transition that dismissed their visible flow. The synchronous
    /// isolation pass must remain final: a late callback cannot recreate hidden
    /// account-owned state while logged out.
    func testPickerCallbacksThatStartAfterSignOutAreRefused() async {
        let states = CurrentValueSubject<SessionState, Never>(readyState("A", retention: 86_400))
        let m = makeModel(enforcesReadyAccount: true)
        m.observe(states)
        states.send(.loggedOut)

        m.chooseFiles(.success([fileURL("late.txt")]))
        var loadedPhoto = false
        await m.importPhotos(count: 1) { _ in
            loadedPhoto = true
            return try self.candidate("late.HEIC")
        }

        XCTAssertFalse(loadedPhoto)
        XCTAssertEqual(upload.state, .idle)
        XCTAssertNil(m.summary)
        XCTAssertNil(m.selectionError)
        XCTAssertTrue(access.heldURLs.isEmpty)
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
    }

    /// The whole point of app-scoped observation: there is no SendView in this
    /// test, and there never was. A `.task` inside a lazily-mounted tab would
    /// fail this.
    ///
    /// The assertion is made IMMEDIATELY after `send`, with no await in
    /// between: isolation must be synchronous with the state write, or an
    /// account-owned transfer keeps running under an account that is gone.
    func testASignOutCancelsAndClearsSynchronouslyWithNoViewInExistence() {
        let states = CurrentValueSubject<SessionState, Never>(readyState("A", retention: 86_400))
        let m = makeModel(); m.observe(states)
        m.chooseFiles(.success([fileURL("a.txt")]))
        upload.start(token: "rlm_A")
        guard case .uploading = upload.state else { return XCTFail("got \(upload.state)") }

        states.send(.loggedOut)

        XCTAssertEqual(upload.state, .idle)
        XCTAssertNil(m.summary)
        XCTAssertTrue(access.heldURLs.isEmpty)
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 0))
        XCTAssertEqual(upload.maxFileSize, 0)
    }

    /// A to B with no sign-out in between. A's link must not be on B's screen.
    func testSwitchingAccountsClearsTheFirstAccountsResultAndCaps() async {
        let states = CurrentValueSubject<SessionState, Never>(readyState("A", retention: 86_400))
        let m = makeModel(); m.observe(states)
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 86_400))
        await upload.applyOutcome(UploadOutcome(id: "abc", expiresAt: 9, keyB64url: "KEY"))
        guard case .done = upload.state else { return XCTFail("got \(upload.state)") }

        states.send(readyState("B", retention: 1_209_600))

        XCTAssertEqual(upload.state, .idle, "account A's link must not sit on account B's screen")
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 1_209_600))
        XCTAssertNil(m.summary)
    }

    /// The identity is the id, not the email — an email can change, and that is
    /// not an account switch.
    func testTheSameAccountWithAChangedEmailIsNotAnAccountSwitch() async {
        let states = CurrentValueSubject<SessionState, Never>(readyState("A", retention: 86_400))
        let m = makeModel(); m.observe(states)
        m.chooseFiles(.success([fileURL("a.txt")]))
        guard case .picked = upload.state else { return XCTFail("got \(upload.state)") }

        var renamed = readyState("A", retention: 86_400)
        if case let .ready(user, usage) = renamed {
            renamed = .ready(user: NativeUser(id: user.id, email: "new@b.co",
                                              displayName: user.displayName,
                                              hasPassword: user.hasPassword,
                                              emailVerified: user.emailVerified,
                                              linkedMethods: user.linkedMethods,
                                              onlyOwnNodes: user.onlyOwnNodes,
                                              planId: user.planId,
                                              subscriptionStatus: user.subscriptionStatus,
                                              subscriptionEnd: user.subscriptionEnd,
                                              hasBilling: user.hasBilling,
                                              scheduledPlanId: user.scheduledPlanId,
                                              scheduledCycle: user.scheduledCycle,
                                              billingCycle: user.billingCycle),
                             usage: usage)
        }
        states.send(renamed)

        XCTAssertEqual(m.summary, expectedSummaryForOneFile,
                       "a changed email must not read as an account switch")
    }

    func testAccountIsolationSupersedesAnImportAndLowersTheFlag() async {
        let states = CurrentValueSubject<SessionState, Never>(readyState("A", retention: 86_400))
        let m = makeModel(); m.observe(states)
        let gate = LoaderGate()
        let importing = Task { await m.importPhotos(count: 1) { _ in
            await gate.wait(at: 0); return try self.candidate("A.HEIC") } }
        await waitUntil { gate.has(reached: 0) }
        XCTAssertTrue(m.isImportingPhotos)

        states.send(.loggedOut)
        XCTAssertFalse(m.isImportingPhotos)

        gate.release()
        await importing.value

        XCTAssertNil(m.summary)
        XCTAssertNil(m.importError, "a superseded import reports no failure")
        XCTAssertTrue(batchDirectoriesOnDisk().isEmpty)
        XCTAssertTrue(inboxCandidatesOnDisk().isEmpty)
    }

    func testAccountIsolationCancelsThePendingConfigFetch() async {
        let states = CurrentValueSubject<SessionState, Never>(SessionState.loggedOut)
        let m = makeModel(); m.observe(states)
        config.hold()
        states.send(readyState("A", retention: 86_400))
        await waitUntil { self.config.entered == 1 }

        states.send(.loggedOut)
        config.release(call: 1, ServerConfig(maxFileSize: 999))
        await settle()

        XCTAssertEqual(upload.maxFileSize, 0,
                       "a fetch for the account being left applies to nobody")
        withExtendedLifetime(m) {}
    }

    // MARK: - caps and staleness

    func testRetentionAppliesSynchronouslyAndTheSizeHintOnlyAfterTheFetch() async {
        let states = CurrentValueSubject<SessionState, Never>(SessionState.loggedOut)
        let m = makeModel(); m.observe(states)
        config.answer(ServerConfig(maxFileSize: 4096))

        states.send(readyState("A", retention: 86_400))
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 86_400),
                       "retention is known now and applied now")
        XCTAssertEqual(upload.maxFileSize, 0, "the hint is not known yet")

        await waitUntil { self.upload.maxFileSize == 4096 }
        XCTAssertEqual(upload.maxFileSize, 4096)
        withExtendedLifetime(m) {}
    }

    /// The case the generation AND the identity guard both exist for.
    ///
    /// A's request is held so it ignores cancellation and genuinely lands, after
    /// the sign-out and after B signed in. That is deliberate: if the hold were
    /// cancellable, cancellation would answer first and these two guards would
    /// never be reached, so the test would pass without exercising the thing it
    /// names. Only call 1 — A's — is released; B's own fetch stays pending, so
    /// `maxFileSize` staying 0 can only mean A's answer was refused.
    func testAStaleConfigResponseAfterLogoutAndAccountSwitchAppliesNothing() async {
        let states = CurrentValueSubject<SessionState, Never>(SessionState.loggedOut)
        let m = makeModel(); m.observe(states)
        config.hold(ignoringCancellation: true)
        states.send(readyState("A", retention: 3600))       // fetch pending
        await waitUntil { self.config.entered == 1 }
        states.send(.loggedOut)
        states.send(readyState("B", retention: 1_209_600))
        await waitUntil { self.config.entered == 2 }        // B is asking too
        config.release(call: 1, ServerConfig(maxFileSize: 999))   // A's answer, late
        await settle()

        XCTAssertEqual(upload.maxFileSize, 0, "account A's hint must not reach account B")
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 1_209_600))
        withExtendedLifetime(m) {}
    }

    /// A slow fetch must not serialize later account events behind it.
    func testASecondAccountEventIsProcessedWhileTheFirstFetchIsStillPending() async {
        let states = CurrentValueSubject<SessionState, Never>(SessionState.loggedOut)
        let m = makeModel(); m.observe(states)
        config.hold()
        states.send(readyState("A", retention: 3600))
        await waitUntil { self.config.entered == 1 }

        states.send(readyState("B", retention: 1_209_600))
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 1_209_600),
                       "the second event is processed immediately, not queued behind the fetch")
        config.release(ServerConfig(maxFileSize: 1))
        withExtendedLifetime(m) {}
    }

    func testDuplicateStatesProduceExactlyOneFetch() async {
        let states = CurrentValueSubject<SessionState, Never>(SessionState.loggedOut)
        let m = makeModel(); m.observe(states)
        config.answer(ServerConfig(maxFileSize: 4096))
        let ready = readyState("A", retention: 86_400)

        states.send(ready)
        states.send(ready)
        states.send(ready)
        await waitUntil { self.upload.maxFileSize == 4096 }
        await settle(10)

        XCTAssertEqual(config.calls, 1,
                       "a usage refresh that changes nothing must not re-fetch")
        withExtendedLifetime(m) {}
    }

    func testAConfigFailureLeavesTheSizeUnknownAndTheFlowUsable() async {
        let states = CurrentValueSubject<SessionState, Never>(SessionState.loggedOut)
        let m = makeModel(); m.observe(states)
        config.fail(TestError.boom)

        states.send(readyState("A", retention: 86_400))
        await waitUntil { self.config.calls == 1 }
        await settle(10)

        XCTAssertEqual(upload.maxFileSize, 0)
        XCTAssertNil(m.selectionError, "an advisory hint failing shows the user nothing")
        m.chooseFiles(.success([fileURL("a.txt")]))
        guard case .picked = upload.state else { return XCTFail("got \(upload.state)") }
    }

    func testNoConfigFetchIsAttemptedWithoutAReadyAccount() async {
        let states = CurrentValueSubject<SessionState, Never>(SessionState.loggedOut)
        let m = makeModel(); m.observe(states)
        for state in [SessionState.restoring, .authenticating, .failed(message: "x"),
                      .unavailable(message: "x"), .emailUnverified(email: "a@b.co"),
                      .pendingDeletion(purgeAfter: 1, reactivateToken: "t")] {
            states.send(state)
        }
        await settle(10)
        XCTAssertEqual(config.calls, 0)
        XCTAssertEqual(upload.ttlChoices, allowedTTLs(retentionSecs: 0))
        withExtendedLifetime(m) {}
    }

    // MARK: - observation and lifetime

    /// A view observing this model does NOT observe the SelectionStore inside
    /// it: `ObservableObject` does not propagate through a stored property. The
    /// failed-expansion path proves the forwarding is real — it never reaches
    /// the upload model, so a view relying on that model's redraws would show
    /// nothing at all.
    func testRenderStateIsPublishedByThisModelAndNotByCoincidence() async {
        let m = makeModel(expand: { _ in throw FileSelectionError.noFiles })
        let changes = Counter()
        let subscription = m.objectWillChange.sink { _ in changes.bump() }

        m.chooseFiles(.success([fileURL("a.txt")]))

        XCTAssertGreaterThan(changes.count, 0,
                             "the model itself must publish, or the view never redraws")
        XCTAssertEqual(upload.state, .idle, "and it did so without touching the upload model")
        XCTAssertNotNil(m.selectionError)
        subscription.cancel()
    }

    /// ARC owns the lifetime. The subscription is an `AnyCancellable` that
    /// cancels itself, and the config task is held in a box that cancels in its
    /// own deinit — so a `@MainActor` deinit never has to reach isolated state.
    ///
    /// The release happens WHILE the fetch is suspended, which is the case a
    /// retain cycle hides in: a task that held `self` strongly across its await
    /// would keep the model alive here and this would fail.
    func testReleasingTheModelCancelsItsSubscriptionAndConfigTask() async {
        let states = CurrentValueSubject<SessionState, Never>(SessionState.loggedOut)
        let subscriptionCancelled = Flag()
        let fetchCancelled = Flag()
        let entered = Flag()
        weak var released: SendSelectionModel?

        do {
            let store = SelectionStore(expand: { urls in
                FileSelection(files: urls.map {
                    SelectedFile(url: $0, relativePath: $0.lastPathComponent)
                }, emptyDirectories: [])
            })
            let m = SendSelectionModel(
                upload: upload, access: access, photos: photos, inbox: inbox,
                fetchConfig: {
                    entered.set()
                    return try await withTaskCancellationHandler {
                        try await Task.sleep(nanoseconds: 30 * NSEC_PER_SEC)
                        return ServerConfig(maxFileSize: 1)
                    } onCancel: { fetchCancelled.set() }
                },
                store: store)
            released = m
            m.observe(states.handleEvents(receiveCancel: { subscriptionCancelled.set() }))
            states.send(readyState("A", retention: 86_400))
            await waitUntil { entered.isSet }
            XCTAssertNotNil(released)
        }

        await waitUntil { released == nil }
        XCTAssertNil(released,
                     "a config task holding self across its await would keep the model alive")
        await waitUntil { subscriptionCancelled.isSet }
        XCTAssertTrue(subscriptionCancelled.isSet, "releasing the model cancels its subscription")
        await waitUntil { fetchCancelled.isSet }
        XCTAssertTrue(fetchCancelled.isSet, "and cancels the config task it owned")
    }

    /// The internal isolation state is not part of the render surface: nothing
    /// renders an account id, and nothing should redraw because one changed.
    ///
    /// The share slice adds three, and they belong here for the same reason the
    /// first four do: the Send surface renders what is waiting in the App Group,
    /// which draft it adopted, and why it refused to adopt one. The internal
    /// state below stays internal — in particular the `SharedDraftStore` itself,
    /// which a view must never reach past this model to read.
    func testTheSendModelPublishesOnlyItsFourRenderProperties() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Sources/RelayiumAppKit/SendSelectionModel.swift"),
            encoding: .utf8)
        // Declarations, not mentions: this file explains at length which state
        // is deliberately NOT `@Published`, and a raw substring count would fail
        // on exactly the comments documenting that decision.
        let declarations = source
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("@Published") }
        XCTAssertEqual(declarations.count, 7,
                       "the four selection properties plus the three shared-draft ones "
                       + "— got \(declarations)")
        for name in ["summary", "selectionError", "isImportingPhotos", "importError",
                     "sharedDrafts", "adoptedDraft", "sharedDraftRefusal"] {
            XCTAssertTrue(declarations.contains { $0.hasSuffix(" var \(name)") || $0.contains(" var \(name):") },
                          "\(name) is not published: \(declarations)")
        }
        for internalState in ["accountUserId", "accountGeneration", "photoGeneration", "drafts"] {
            XCTAssertFalse(declarations.contains { $0.contains(" var \(internalState)") },
                           "\(internalState) is isolation state, not part of the render surface")
        }
    }
}
