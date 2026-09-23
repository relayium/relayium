import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// A newly shared draft is LOADED — never sent — when the user comes back to an
/// empty Send screen, at most once, and never over anything else.
///
/// Every model here gets a private temporary draft root and a private defaults
/// suite that is removed afterwards. Nothing reads or writes the real App Group
/// or this process's standard defaults.
@MainActor
final class SharedDraftArrivalTests: XCTestCase {
    private var root: URL!
    private var drafts: SharedDraftStore!
    private var suiteName: String!
    private var defaults: UserDefaults!
    private var transport: CountingTransport!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("share-arrival-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // Under a parent of its own, as the real one sits under the App Group
        // container: the parent is what an access failure can hide it behind.
        drafts = SharedDraftStore(root: group.appendingPathComponent("SharedDrafts"))
        suiteName = "relayium.tests.share-arrival.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        transport = CountingTransport()
    }

    override func tearDownWithError() throws {
        let fm = FileManager.default
        try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: group.path)
        try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: drafts.root.path)
        for name in (try? fm.contentsOfDirectory(atPath: drafts.root.path)) ?? [] {
            try? fm.setAttributes([.posixPermissions: 0o755],
                                  ofItemAtPath: drafts.root.appendingPathComponent(name).path)
        }
        try? FileManager.default.removeItem(at: root)
        defaults.removePersistentDomain(forName: suiteName)
    }

    // MARK: - doubles and helpers

    /// The drafts root's parent — the App Group container's stand-in.
    private var group: URL { root.appendingPathComponent("AppGroup") }

    /// Counts every call that would reach the network. Automatic loading must
    /// leave all of them at zero: it selects, it does not send.
    private final class CountingTransport: ResumableTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var calls: Int { lock.lock(); defer { lock.unlock() }; return count }
        private func hit() { lock.lock(); count += 1; lock.unlock() }

        func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            hit(); throw CloudError.network
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            hit(); throw CloudError.network
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int {
            hit(); throw CloudError.network
        }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            hit(); throw CloudError.network
        }
    }

    private actor Gate {
        private var entered = false
        private var released = false
        private var arrival: CheckedContinuation<Void, Never>?
        private var departure: CheckedContinuation<Void, Never>?

        func arriveAndWait() async {
            entered = true
            arrival?.resume()
            arrival = nil
            guard !released else { return }
            await withCheckedContinuation { departure = $0 }
        }

        func waitUntilEntered() async {
            guard !entered else { return }
            await withCheckedContinuation { arrival = $0 }
        }

        func release() {
            released = true
            departure?.resume()
            departure = nil
        }
    }

    /// A pending-key store whose read parks until released, then answers.
    private final class GatedKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        let gate = Gate()
        private let stored: String?
        init(returning stored: String?) { self.stored = stored }
        func save(id: String, keyB64url: String) async throws {}
        func key(for id: String) async throws -> String? {
            await gate.arriveAndWait()
            return stored
        }
        func remove(id: String) async throws {}
    }

    @discardableResult
    private func stageDraft(_ contents: String = "shared", named: String = "shared.txt") throws -> SharedDraftPlan {
        let source = root.appendingPathComponent("source-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let file = source.appendingPathComponent(named)
        try Data(contents.utf8).write(to: file)
        let writer = try drafts.beginDraft()
        try writer.adopt(file, suggestedName: named)
        return try writer.publish()
    }

    private var pendingStore: PendingUploadStore {
        PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
    }

    private func makeUpload(pendingKeys: StoredLinkKeyStore = InMemoryStoredLinkKeyStore()) -> CloudUploadModel {
        CloudUploadModel(
            uploader: CloudUploader(transport: transport),
            keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://relayium.com",
            pending: PendingUploadSupport(store: pendingStore, keys: pendingKeys, drafts: drafts))
    }

    private func ledger() -> SharedDraftArrivalLedger { SharedDraftArrivalLedger(defaults: defaults) }

    /// A ledger an earlier run of this version already seeded, with nothing
    /// handled — the steady state every test except the upgrade one starts in.
    private func seededLedger(_ ids: [String] = []) -> SharedDraftArrivalLedger {
        let ledger = ledger()
        ledger.seed(ids)
        return ledger
    }

    private func makeSend(upload: CloudUploadModel,
                          session: CurrentValueSubject<SessionState, Never>,
                          arrivals: SharedDraftArrivalLedger?,
                          maxFileSize: Int64 = 0) -> SendSelectionModel {
        let model = SendSelectionModel(
            upload: upload,
            photos: PhotoStagingArea(root: root.appendingPathComponent("photos")),
            inbox: root.appendingPathComponent("inbox"),
            drafts: drafts,
            fetchConfig: { ServerConfig(maxFileSize: maxFileSize) },
            arrivals: arrivals)
        model.observe(session)
        return model
    }

    private func ready(_ id: String = "acct-1") -> SessionState {
        .ready(user: NativeUser(id: id, email: "\(id)@b.co", displayName: id,
                                hasPassword: true, emailVerified: true,
                                linkedMethods: ["password"], onlyOwnNodes: false,
                                planId: "pro", subscriptionStatus: "active",
                                subscriptionEnd: 0, hasBilling: true,
                                scheduledPlanId: "", scheduledCycle: "",
                                billingCycle: "monthly"),
               usage: UsageResponse(period: "202608", resetsAt: 0,
                                    traffic: Meter(used: 0, cap: 0),
                                    storage: Meter(used: 0, cap: 0),
                                    plan: PlanInfo(id: "pro", name: "Pro", storageBytes: 0,
                                                   trafficBytes: 0, retentionSecs: 86_400,
                                                   priceMonthly: 0, priceYearly: 0, isTop: false,
                                                   subscriptionStatus: "active", subscriptionEnd: 0,
                                                   billingCycle: "monthly", scheduledPlanId: "",
                                                   scheduledPlanName: "", scheduledCycle: "")))
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    /// Long enough for any listing already requested to have landed.
    private func quiesce() async {
        try? await Task.sleep(nanoseconds: 150_000_000)
    }

    private func signals(of send: SendSelectionModel) -> (AnyCancellable, () -> [SharedDraftArrivalSignal]) {
        var seen: [SharedDraftArrivalSignal] = []
        let sub = send.arrivalSignals.sink { seen.append($0) }
        return (sub, { seen })
    }

    /// The draft is the selection, as a tap on Use would have made it, and
    /// nothing reached the network.
    private func assertLoaded(_ plan: SharedDraftPlan, _ send: SendSelectionModel,
                              _ upload: CloudUploadModel,
                              file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(send.adoptedDraft?.id, plan.id, file: file, line: line)
        XCTAssertEqual(upload.sourceDraftId, plan.id, file: file, line: line)
        guard case let .picked(files) = upload.state else {
            return XCTFail("expected .picked, got \(upload.state)", file: file, line: line)
        }
        XCTAssertEqual(files.map(\.relativePath), plan.files.map(\.name), file: file, line: line)
        XCTAssertFalse(send.sharedDrafts.contains { $0.id == plan.id }, file: file, line: line)
        XCTAssertNil(send.selectionError, file: file, line: line)
        XCTAssertEqual(transport.calls, 0, "loading a draft must not send it", file: file, line: line)
    }

    private func assertNotLoaded(_ send: SendSelectionModel, _ upload: CloudUploadModel,
                                 file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(send.adoptedDraft, file: file, line: line)
        XCTAssertNil(upload.sourceDraftId, file: file, line: line)
        XCTAssertEqual(transport.calls, 0, file: file, line: line)
    }

    // MARK: - the case the feature exists for

    /// Signed in, nothing on the Send screen, one draft shared from another
    /// app: coming back loads it. It is the old code's behaviour this reverses —
    /// there the draft only ever became a card.
    func testASingleNewDraftIsLoadedWhenTheUserComesBack() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let arrivals = seededLedger()
        let send = makeSend(upload: upload, session: session, arrivals: arrivals)
        let (sub, seen) = signals(of: send)
        defer { sub.cancel() }
        await upload.recoveryTask?.value

        send.phaseChanged(to: .background)
        let plan = try stageDraft()
        send.phaseChanged(to: .active)
        await waitUntil { send.adoptedDraft != nil }

        assertLoaded(plan, send, upload)
        XCTAssertTrue(arrivals.contains(plan.id))
        XCTAssertEqual(seen(), [.leftForeground, .draftLoaded], "exactly one load signal")
        // Still the user's to send: nothing started, and the source is intact.
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id])
    }

    /// Cold launch after sharing: the session is still restoring when the scene
    /// becomes active. Judging then would read as "signed out"; the load waits
    /// for the restore to land on an account and then happens.
    func testAColdLaunchWaitsForTheRestoreAndThenLoads() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(.restoring)
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())

        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send, upload)
        XCTAssertFalse(send.arrivals!.contains(plan.id), "deferred, not spent, while restoring")

        session.send(ready())
        await waitUntil { send.adoptedDraft != nil }
        assertLoaded(plan, send, upload)
    }

    /// The listing lands while the restored account's recovery scan is still
    /// running. Nothing re-judges on its own when recovery finishes — unless
    /// the model waits for it, the cold-launch path never loads.
    func testAListingThatLandsDuringTheRecoveryCheckIsJudgedAfterIt() async throws {
        let plan = try stageDraft()
        // A job with no readable key: recovery parks on the key read, then
        // purges the job and returns to idle.
        let source = root.appendingPathComponent("old.bin")
        try Data("old".utf8).write(to: source)
        _ = try pendingStore.prepare(files: [SelectedFile(url: source, relativePath: "old.bin")],
                                     accountId: "acct-1", burnAfterRead: false, ttl: 3600)
        let keys = GatedKeyStore(returning: nil)
        let session = CurrentValueSubject<SessionState, Never>(.restoring)
        let upload = makeUpload(pendingKeys: keys)
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())

        send.phaseChanged(to: .active)
        session.send(ready())
        await keys.gate.waitUntilEntered()
        XCTAssertEqual(upload.state, .checkingRecovery)
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send, upload)

        await keys.gate.release()
        await waitUntil { send.adoptedDraft != nil }
        assertLoaded(plan, send, upload)
    }

    /// Recovery finds a durable job whose source is a draft nobody has handled.
    /// The job takes it: the draft is retired exactly as before, the job is
    /// offered, and nothing is loaded over the offer.
    func testRecoveryOwnsItsSourceAndIsNeverOverwritten() async throws {
        let plan = try stageDraft()
        let source = root.appendingPathComponent("job.bin")
        try Data("job".utf8).write(to: source)
        let job = try pendingStore.prepare(
            files: [SelectedFile(url: source, relativePath: "job.bin")],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600, sourceDraftId: plan.id)
        let keys = InMemoryStoredLinkKeyStore()
        try await keys.save(id: job.jobId, keyB64url: encodeStoreKey(generateStoreKey()))
        let other = try stageDraft("other", named: "other.txt")

        let session = CurrentValueSubject<SessionState, Never>(.restoring)
        let upload = makeUpload(pendingKeys: keys)
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        send.phaseChanged(to: .active)
        session.send(ready())
        await waitUntil { send.arrivals!.contains(other.id) }
        await quiesce()

        guard case .interrupted = upload.state else {
            return XCTFail("the recovered job must still be offered, got \(upload.state)")
        }
        XCTAssertEqual(drafts.drafts().map(\.id), [other.id], "the job's source is retired")
        assertNotLoaded(send, upload)
        XCTAssertEqual(send.sharedDrafts.map(\.id), [other.id])
    }

    // MARK: - never over anything, never more than once

    func testSeveralNewDraftsAreLeftForTheUserToChoose() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value

        let first = try stageDraft("a", named: "a.txt")
        let second = try stageDraft("b", named: "b.txt")
        send.phaseChanged(to: .active)
        await waitUntil { send.arrivals!.contains(first.id) && send.arrivals!.contains(second.id) }
        await quiesce()
        assertNotLoaded(send, upload)
        XCTAssertEqual(Set(send.sharedDrafts.map(\.id)), [first.id, second.id])
        XCTAssertEqual(upload.state, .idle)

        // Discarding one does not make the other "the" new draft.
        send.discardSharedDraft(first.id)
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.map(\.id) == [second.id] }
        await quiesce()
        assertNotLoaded(send, upload)
        XCTAssertFalse(send.arrivals!.contains(first.id), "a discarded draft's id is forgotten")
    }

    func testAUsersOwnSelectionIsNeverReplaced() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        let mine = root.appendingPathComponent("mine.txt")
        try Data("mine".utf8).write(to: mine)
        send.chooseFiles(.success([mine]))
        guard case .picked = upload.state else { return XCTFail("setup: \(upload.state)") }

        let plan = try stageDraft()
        send.phaseChanged(to: .active)
        await waitUntil { send.arrivals!.contains(plan.id) }
        await quiesce()
        assertNotLoaded(send, upload)
        guard case let .picked(files) = upload.state else { return XCTFail("\(upload.state)") }
        XCTAssertEqual(files.map(\.relativePath), ["mine.txt"])

        // And it had its one chance: clearing and coming back does not load it.
        send.clear()
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await quiesce()
        assertNotLoaded(send, upload)
        XCTAssertEqual(send.sharedDrafts.map(\.id), [plan.id])
    }

    /// `importPhotos` sets the upload state to idle before its first await, so
    /// the upload gate alone would admit a draft — and loading one supersedes
    /// the import the user is waiting on.
    func testAPhotoImportInFlightIsNeverSuperseded() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value

        let gate = Gate()
        let importing = Task { @MainActor in
            await send.importPhotos(count: 1) { _ in
                await gate.arriveAndWait()
                throw CancellationError()
            }
        }
        await gate.waitUntilEntered()
        XCTAssertTrue(send.isImportingPhotos)
        XCTAssertEqual(upload.state, .idle)

        let plan = try stageDraft()
        send.phaseChanged(to: .active)
        await waitUntil { send.arrivals!.contains(plan.id) }
        await quiesce()
        assertNotLoaded(send, upload)
        XCTAssertTrue(send.isImportingPhotos, "the import was superseded")

        await gate.release()
        await importing.value
    }

    func testAFailureTheUserIsReadingIsNeverReplaced() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        send.chooseFiles(.failure(CocoaError(.fileReadNoPermission)))
        upload.pick(FileSelection(files: [], emptyDirectories: []))
        guard case .failed = upload.state else { return XCTFail("setup: \(upload.state)") }

        let plan = try stageDraft()
        send.phaseChanged(to: .active)
        await waitUntil { send.arrivals!.contains(plan.id) }
        await quiesce()
        assertNotLoaded(send, upload)
        guard case .failed = upload.state else { return XCTFail("\(upload.state)") }
    }

    /// Too large for this plan: exactly what Use does — refused, back to its
    /// card, a real failure line — and never retried on the next activation.
    func testAnOversizedArrivalIsRefusedOnceAndNotRetried() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger(), maxFileSize: 2)
        await upload.recoveryTask?.value
        await waitUntil { upload.maxFileSize == 2 }

        let plan = try stageDraft("far too large")
        send.phaseChanged(to: .active)
        await waitUntil { send.arrivals!.contains(plan.id) }
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        assertNotLoaded(send, upload)
        guard case .failed = upload.state else { return XCTFail("\(upload.state)") }

        send.resetUpload()
        XCTAssertEqual(upload.state, .idle)
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await quiesce()
        XCTAssertEqual(upload.state, .idle, "retried a draft it already refused")
        assertNotLoaded(send, upload)
    }

    // MARK: - removal stays removal, across restarts

    func testClearAfterALoadIsNotUndoneByComingBackOrByARestart() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        let plan = try stageDraft()
        send.phaseChanged(to: .active)
        await waitUntil { send.adoptedDraft != nil }
        assertLoaded(plan, send, upload)

        send.clear()
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await quiesce()
        assertNotLoaded(send, upload)

        // iOS kills the app in the background; the next process reads the same
        // defaults and must agree. Asserted on the stored state as well as the
        // behaviour: an unseeded ledger would ALSO leave this draft alone, by
        // treating it as pre-existing, and hide a ledger that never persisted.
        let reread = ledger()
        XCTAssertTrue(reread.isSeeded)
        XCTAssertTrue(reread.contains(plan.id))
        let upload2 = makeUpload()
        let send2 = makeSend(upload: upload2, session: CurrentValueSubject(ready()),
                             arrivals: reread)
        await upload2.recoveryTask?.value
        send2.phaseChanged(to: .active)
        await waitUntil { send2.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        XCTAssertNil(send2.adoptedDraft)
        XCTAssertEqual(upload2.state, .idle)

        // And the restarted process still loads what is genuinely new.
        let next = try stageDraft("next", named: "next.txt")
        send2.phaseChanged(to: .background)
        send2.phaseChanged(to: .active)
        await waitUntil { send2.adoptedDraft != nil }
        XCTAssertEqual(send2.adoptedDraft?.id, next.id)
    }

    /// A read error lists nothing, exactly like an empty inbox. It must neither
    /// seed nor forget: afterwards the handled draft is still handled.
    func testAnUnreadableInboxForgetsNothing() async throws {
        let plan = try stageDraft()
        let arrivals = seededLedger([plan.id])
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: arrivals)
        await upload.recoveryTask?.value
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }

        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: drafts.root.path)
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.isEmpty }
        await quiesce()
        XCTAssertEqual(defaults.array(forKey: SharedDraftArrivalLedger.defaultsKey) as? [String], [plan.id])

        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: drafts.root.path)
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send, upload)
    }

    // MARK: - an unreadable inbox is not an empty one

    private func chmod(_ url: URL, _ mode: Int) throws {
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
    }

    /// The case the root reviewer's probe found, taken apart. With the PARENT
    /// unsearchable, `fileExists` says the root is not there and listing it
    /// fails with Cocoa's "no such file" — although the root and every draft in
    /// it are. Only a provable absence may read as "no root".
    func testOnlyAProvablyAbsentRootReadsAsEmpty() throws {
        let fm = FileManager.default
        XCTAssertEqual(SharedDraftArrivalLedger.presentEntries(in: drafts.root), [],
                       "a root never created is genuinely empty")
        XCTAssertEqual(SharedDraftArrivalLedger.presentEntries(
            in: root.appendingPathComponent("missing/SharedDrafts")), [],
                       "so is one whose parent does not exist")
        let plan = try stageDraft()
        XCTAssertEqual(SharedDraftArrivalLedger.presentEntries(in: drafts.root)?.contains(plan.id), true)

        try chmod(group, 0o000)
        defer { try? chmod(group, 0o755) }
        // Preconditions: the ambiguity is real on this system, so the
        // assertion below is testing something.
        XCTAssertFalse(fm.fileExists(atPath: drafts.root.path),
                       "precondition: an unsearchable parent hides the root from fileExists")
        XCTAssertThrowsError(try fm.contentsOfDirectory(atPath: drafts.root.path))
        XCTAssertNil(SharedDraftArrivalLedger.presentEntries(in: drafts.root),
                     "an unsearchable parent read as an empty inbox")
        XCTAssertFalse(SharedDraftArrivalLedger.isProvablyAbsent(drafts.draftURL(id: plan.id)),
                       "a draft behind an unsearchable parent read as deleted")
        try chmod(group, 0o755)

        try chmod(drafts.root, 0o000)
        XCTAssertNil(SharedDraftArrivalLedger.presentEntries(in: drafts.root),
                     "an unreadable root read as an empty inbox")
        try chmod(drafts.root, 0o755)

        XCTAssertTrue(drafts.discard(id: plan.id))
        XCTAssertTrue(SharedDraftArrivalLedger.isProvablyAbsent(drafts.draftURL(id: plan.id)))
    }

    /// However a draft came to be handled — cleared after a load, passed over
    /// at an account boundary, or already waiting at the upgrade — an access
    /// failure on the way to it, at the parent or at the draft itself, must
    /// not make it new again: not in this process, and not in the next one.
    private enum HandledBy: CaseIterable { case clear, accountBoundary, upgradeSeed }

    private func handledDraft(_ how: HandledBy) async throws
        -> (SharedDraftPlan, SendSelectionModel, CloudUploadModel) {
        let session = CurrentValueSubject<SessionState, Never>(ready("acct-A"))
        let upload = makeUpload()
        let plan: SharedDraftPlan
        let send: SendSelectionModel
        switch how {
        case .clear:
            send = makeSend(upload: upload, session: session, arrivals: seededLedger())
            await upload.recoveryTask?.value
            plan = try stageDraft()
            send.phaseChanged(to: .active)
            await waitUntil { send.adoptedDraft != nil }
            assertLoaded(plan, send, upload)
            send.clear()
        case .accountBoundary:
            send = makeSend(upload: upload, session: session, arrivals: seededLedger())
            await upload.recoveryTask?.value
            plan = try stageDraft()
            session.send(ready("acct-B"))
            await upload.recoveryTask?.value
            await waitUntil { send.arrivals!.contains(plan.id) }
        case .upgradeSeed:
            plan = try stageDraft()
            send = makeSend(upload: upload, session: session, arrivals: ledger())
            await upload.recoveryTask?.value
            send.phaseChanged(to: .active)
            await waitUntil { send.arrivals!.isSeeded }
        }
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send, upload)
        XCTAssertEqual(defaults.array(forKey: SharedDraftArrivalLedger.defaultsKey) as? [String],
                       [plan.id], "precondition: handled and persisted")
        return (plan, send, upload)
    }

    /// Comes back while `target` is unreadable, then again once it is readable,
    /// then as a fresh process: the draft is a card throughout, never loaded.
    private func assertStaysHandled(_ plan: SharedDraftPlan, _ send: SendSelectionModel,
                                    _ upload: CloudUploadModel, behind target: URL,
                                    _ label: String) async throws {
        try chmod(target, 0o000)
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.isEmpty }
        await quiesce()
        try chmod(target, 0o755)
        XCTAssertEqual(defaults.array(forKey: SharedDraftArrivalLedger.defaultsKey) as? [String],
                       [plan.id], "\(label): an access failure forgot a handled draft")

        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send, upload)

        let upload2 = makeUpload()
        let send2 = makeSend(upload: upload2, session: CurrentValueSubject(ready("acct-B")),
                             arrivals: ledger())
        await upload2.recoveryTask?.value
        send2.phaseChanged(to: .active)
        await waitUntil { send2.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        XCTAssertNil(send2.adoptedDraft, "\(label): loaded on relaunch after an access failure")
        XCTAssertEqual(upload2.state, .idle, label)
        XCTAssertEqual(transport.calls, 0)
    }

    func testAnUnsearchableParentForgetsNothingAcrossARelaunch() async throws {
        for (index, how) in HandledBy.allCases.enumerated() {
            if index > 0 { try tearDownWithError(); try setUpWithError() }
            let (plan, send, upload) = try await handledDraft(how)
            try await assertStaysHandled(plan, send, upload, behind: group, "parent/\(how)")
        }
    }

    func testAnUnreadableDraftDirectoryForgetsNothingAcrossARelaunch() async throws {
        for (index, how) in HandledBy.allCases.enumerated() {
            if index > 0 { try tearDownWithError(); try setUpWithError() }
            let (plan, send, upload) = try await handledDraft(how)
            try await assertStaysHandled(plan, send, upload,
                                         behind: drafts.draftURL(id: plan.id), "leaf/\(how)")
        }
    }

    /// Discard whose removal cannot even reach the draft: `fileExists` says
    /// false, but the draft is still there, and it must not come back as new.
    /// Asserted straight after the call, before any listing, so this is the
    /// discard path and not the pruning one.
    func testADiscardThatCannotReachTheDraftForgetsNothing() async throws {
        let (plan, send, _) = try await handledDraft(.upgradeSeed)
        try chmod(group, 0o000)
        send.discardSharedDraft(plan.id)
        XCTAssertEqual(defaults.array(forKey: SharedDraftArrivalLedger.defaultsKey) as? [String],
                       [plan.id], "a discard that failed forgot the draft")
        await quiesce()
        try chmod(group, 0o755)
        XCTAssertTrue(FileManager.default.fileExists(atPath: drafts.draftURL(id: plan.id).path),
                      "precondition: the discard really did not happen")

        let upload2 = makeUpload()
        let send2 = makeSend(upload: upload2, session: CurrentValueSubject(ready()), arrivals: ledger())
        await upload2.recoveryTask?.value
        send2.phaseChanged(to: .active)
        await waitUntil { send2.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send2, upload2)

        // And a discard that did happen forgets it — the history is bounded
        // by what is really on disk.
        send2.discardSharedDraft(plan.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: drafts.draftURL(id: plan.id).path))
        XCTAssertEqual(defaults.array(forKey: SharedDraftArrivalLedger.defaultsKey) as? [String], [])
    }

    /// A draft really deleted behind the app's back is pruned; the same draft
    /// merely hidden is not. The difference is the whole point of the fix.
    func testAReallyDeletedDraftIsPruned() async throws {
        let (plan, send, upload) = try await handledDraft(.upgradeSeed)
        try FileManager.default.removeItem(at: drafts.draftURL(id: plan.id))
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.isEmpty }
        await waitUntil { !send.arrivals!.contains(plan.id) }
        XCTAssertEqual(defaults.array(forKey: SharedDraftArrivalLedger.defaultsKey) as? [String], [])
        assertNotLoaded(send, upload)
    }

    // MARK: - the first run of this version

    func testDraftsAlreadyWaitingAtUpgradeAreNotLoadedButLaterOnesAre() async throws {
        let old = try stageDraft("old", named: "old.txt")
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let arrivals = ledger()
        XCTAssertFalse(arrivals.isSeeded)
        let send = makeSend(upload: upload, session: session, arrivals: arrivals)
        await upload.recoveryTask?.value
        send.phaseChanged(to: .active)
        await waitUntil { arrivals.isSeeded }
        await quiesce()
        assertNotLoaded(send, upload)
        XCTAssertTrue(arrivals.contains(old.id))

        let new = try stageDraft("new", named: "new.txt")
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.adoptedDraft != nil }
        assertLoaded(new, send, upload)
        XCTAssertEqual(send.sharedDrafts.map(\.id), [old.id])
    }

    /// First run of this version with an old draft whose plan cannot be read
    /// right now, although its directory lists: the store leaves it out, but
    /// it is still an old draft. It is seeded from the directory, so once its
    /// plan reads again it is a card and not a new arrival — and what is
    /// genuinely shared after the seed still loads.
    func testAnOldDraftWhosePlanIsUnreadableAtUpgradeIsStillSeeded() async throws {
        let old = try stageDraft("old", named: "old.txt")
        try chmod(drafts.draftURL(id: old.id), 0o000)
        XCTAssertTrue(drafts.drafts().isEmpty, "precondition: the store cannot list it")
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let arrivals = ledger()
        let send = makeSend(upload: upload, session: session, arrivals: arrivals)
        await upload.recoveryTask?.value
        send.phaseChanged(to: .active)
        await waitUntil { arrivals.isSeeded }
        await quiesce()
        XCTAssertTrue(arrivals.contains(old.id), "an old draft missed the seed")
        XCTAssertEqual(defaults.array(forKey: SharedDraftArrivalLedger.defaultsKey) as? [String], [old.id],
                       "only opaque draft ids are stored")

        try chmod(drafts.draftURL(id: old.id), 0o755)
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.map(\.id) == [old.id] }
        await quiesce()
        assertNotLoaded(send, upload)

        let new = try stageDraft("new", named: "new.txt")
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.adoptedDraft != nil }
        assertLoaded(new, send, upload)
        XCTAssertEqual(send.sharedDrafts.map(\.id), [old.id])
    }

    /// First run with the whole inbox behind an unsearchable parent: nothing
    /// is seeded — "no root" is not provable — and once it is reachable the
    /// old draft is seeded as old, not loaded.
    func testAnUnreachableInboxAtUpgradeDefersTheSeed() async throws {
        let old = try stageDraft("old", named: "old.txt")
        try chmod(group, 0o000)
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let arrivals = ledger()
        let send = makeSend(upload: upload, session: session, arrivals: arrivals)
        await upload.recoveryTask?.value
        send.phaseChanged(to: .active)
        await quiesce()
        XCTAssertFalse(arrivals.isSeeded, "seeded from an inbox it could not see")
        XCTAssertNil(defaults.object(forKey: SharedDraftArrivalLedger.defaultsKey))

        try chmod(group, 0o755)
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { arrivals.isSeeded }
        await quiesce()
        XCTAssertTrue(arrivals.contains(old.id))
        assertNotLoaded(send, upload)
    }

    /// The genuine first run: no inbox has ever been created. That seeds as
    /// empty — it is provably empty — so the very first draft ever shared is
    /// a new arrival and loads.
    func testAGenuinelyAbsentInboxSeedsEmptyAndTheFirstShareLoads() async throws {
        XCTAssertFalse(FileManager.default.fileExists(atPath: group.path), "precondition")
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let arrivals = ledger()
        let send = makeSend(upload: upload, session: session, arrivals: arrivals)
        await upload.recoveryTask?.value
        send.phaseChanged(to: .active)
        await waitUntil { arrivals.isSeeded }
        XCTAssertEqual(defaults.array(forKey: SharedDraftArrivalLedger.defaultsKey) as? [String], [])

        let first = try stageDraft()
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.adoptedDraft != nil }
        assertLoaded(first, send, upload)
    }

    /// A tap on Use before the first listing must not seed the ledger with that
    /// one id — every other waiting draft would then look new.
    func testAnExplicitUseBeforeSeedingDoesNotSeed() {
        let arrivals = ledger()
        arrivals.record(["A"])
        XCTAssertFalse(arrivals.isSeeded)
        XCTAssertNil(defaults.object(forKey: SharedDraftArrivalLedger.defaultsKey))
        XCTAssertFalse(ledger().isSeeded)
    }

    // MARK: - accounts

    /// Loaded under A, handed back on the switch, and never loaded for B.
    func testADraftLoadedForOneAccountIsNeverLoadedForTheNext() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready("acct-A"))
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        let plan = try stageDraft()
        send.phaseChanged(to: .active)
        await waitUntil { send.adoptedDraft != nil }

        session.send(ready("acct-B"))
        XCTAssertNil(send.adoptedDraft, "returned synchronously on the switch")
        await upload.recoveryTask?.value
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send, upload)
    }

    /// The same, when A chose it by hand rather than the app loading it.
    func testADraftUsedByHandUnderOneAccountIsNeverLoadedForTheNext() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready("acct-A"))
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        let plan = try stageDraft()
        send.refreshSharedDrafts()
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        send.useSharedDraft(plan.id)
        XCTAssertEqual(send.adoptedDraft?.id, plan.id)

        session.send(ready("acct-B"))
        await upload.recoveryTask?.value
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send, upload)
    }

    /// Listed under A but never judged — it arrived while the app was already
    /// in front, so only the Send tab's own read saw it. Switching to B is a
    /// boundary: B's next activation must not treat it as new.
    func testAnUnjudgedDraftDoesNotCrossAnAccountSwitch() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready("acct-A"))
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        let plan = try stageDraft()
        send.refreshSharedDrafts()
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        XCTAssertFalse(send.arrivals!.contains(plan.id))

        session.send(ready("acct-B"))
        await upload.recoveryTask?.value
        await waitUntil { send.arrivals!.contains(plan.id) }
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await quiesce()
        assertNotLoaded(send, upload)
    }

    /// Used by hand, then cleared: back to a card, and it stays one.
    func testClearAfterAHandUseIsNotUndoneByComingBack() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        let plan = try stageDraft()
        send.refreshSharedDrafts()
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        send.useSharedDraft(plan.id)
        XCTAssertEqual(send.adoptedDraft?.id, plan.id)
        send.clear()
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }

        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await quiesce()
        assertNotLoaded(send, upload)
    }

    /// Shared while nobody is signed in, including a launch whose restore finds
    /// no token: never loaded, not even once somebody signs in. Use still works.
    func testNothingSharedWhileSignedOutIsLoadedForWhoeverSignsIn() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(.restoring)
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        send.phaseChanged(to: .active)
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        session.send(.loggedOut)
        await waitUntil { send.arrivals!.contains(plan.id) }
        XCTAssertTrue(send.arrivals!.contains(plan.id), "judged as signed out once the restore ended")
        assertNotLoaded(send, upload)

        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await quiesce()
        session.send(ready())
        await upload.recoveryTask?.value
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await quiesce()
        assertNotLoaded(send, upload)

        send.useSharedDraft(plan.id)
        assertLoaded(plan, send, upload)
    }

    /// A draft that arrives while signed in, but the user signs out before the
    /// listing lands: the stale listing loads nothing.
    func testAListingThatLandsAfterSignOutLoadsNothing() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        let plan = try stageDraft()
        send.phaseChanged(to: .active)
        session.send(.loggedOut)
        await waitUntil { send.arrivals!.contains(plan.id) }
        await quiesce()
        assertNotLoaded(send, upload)
        session.send(ready())
        await upload.recoveryTask?.value
        await quiesce()
        assertNotLoaded(send, upload)
    }

    // MARK: - only the scene becoming active loads

    func testTheSendSurfaceAndAccountRefreshesNeverLoad() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session, arrivals: seededLedger())
        await upload.recoveryTask?.value
        let plan = try stageDraft()

        send.refreshSharedDrafts()                  // SendView.task
        await waitUntil { send.sharedDrafts.map(\.id) == [plan.id] }
        await quiesce()
        assertNotLoaded(send, upload)

        send.phaseChanged(to: .inactive)            // a picker coming up
        await quiesce()
        assertNotLoaded(send, upload)
        XCTAssertFalse(send.arrivals!.contains(plan.id))

        // And the same account's usage refresh changes nothing either.
        if case let .ready(user, usage) = ready() {
            session.send(.ready(user: user, usage: usage))
        }
        await quiesce()
        assertNotLoaded(send, upload)
    }

    /// No draft store — macOS — means no ledger and nothing to arrive.
    func testWithoutADraftStoreThereIsNoLedger() {
        let model = SendSelectionModel(upload: makeUpload(), drafts: nil,
                                       fetchConfig: { ServerConfig(maxFileSize: 0) },
                                       arrivals: ledger())
        XCTAssertNil(model.arrivals)
    }

    // MARK: - production wiring

    /// The factory the app calls is what turns the behaviour on. Given the
    /// same store the app gives it, it loads a new draft — against a private
    /// suite here, never the real defaults.
    func testTheProductionFactoryEnablesLoading() async throws {
        let upload = makeUpload()
        let send = AppEnvironment.makeSendSelectionModel(
            baseURL: URL(string: "https://127.0.0.1:9")!,
            upload: upload, drafts: drafts, arrivalDefaults: defaults)
        XCTAssertNotNil(send.arrivals)
        let session = CurrentValueSubject<SessionState, Never>(ready())
        send.observe(session)
        await upload.recoveryTask?.value
        send.phaseChanged(to: .active)
        await waitUntil { send.arrivals!.isSeeded }
        let plan = try stageDraft()
        send.phaseChanged(to: .background)
        send.phaseChanged(to: .active)
        await waitUntil { send.adoptedDraft != nil }
        assertLoaded(plan, send, upload)

        XCTAssertNil(AppEnvironment.makeSendSelectionModel(upload: makeUpload(), drafts: nil,
                                                           arrivalDefaults: defaults).arrivals)
    }

    // MARK: - whether the Send tab also comes forward

    func testTheSendTabComesForwardOnlyWhenNothingElseChoseADestination() {
        var nav = SharedDraftArrivalNavigation()
        // Nothing moved since launch: bring Send forward.
        XCTAssertTrue(nav.handle(.draftLoaded, selectionWrites: 0, current: .nearby, linkPending: false))
        // The select that answer caused is not held against the next arrival.
        XCTAssertFalse(nav.handle(.draftLoaded, selectionWrites: 1, current: .storedSend, linkPending: false),
                       "already on Send: nothing to do")
        XCTAssertTrue(nav.handle(.leftForeground, selectionWrites: 1, current: .storedSend,
                                 linkPending: false) == false)
        XCTAssertTrue(nav.handle(.draftLoaded, selectionWrites: 1, current: .account, linkPending: false))

        // A link still pending.
        var pending = SharedDraftArrivalNavigation()
        XCTAssertFalse(pending.handle(.draftLoaded, selectionWrites: 0, current: .nearby, linkPending: true))

        // A link already delivered and consumed — before OR after activation:
        // either way it selected, and the counter moved.
        var consumed = SharedDraftArrivalNavigation()
        _ = consumed.handle(.leftForeground, selectionWrites: 4, current: .nearby, linkPending: false)
        XCTAssertFalse(consumed.handle(.draftLoaded, selectionWrites: 5, current: .pairingCode,
                                       linkPending: false))

        // A tab the user tapped while the inbox was being read.
        var tapped = SharedDraftArrivalNavigation()
        XCTAssertFalse(tapped.handle(.draftLoaded, selectionWrites: 1, current: .deviceInbox,
                                     linkPending: false))

        // The stored-receive sheet the user was in when they left.
        var sheet = SharedDraftArrivalNavigation()
        _ = sheet.handle(.leftForeground, selectionWrites: 2, current: .storedReceive, linkPending: false)
        XCTAssertFalse(sheet.handle(.draftLoaded, selectionWrites: 2, current: .storedReceive,
                                    linkPending: false))

        // Returning from the background re-baselines: an old tab choice does
        // not block a later, genuinely unattended arrival.
        var later = SharedDraftArrivalNavigation()
        _ = later.handle(.leftForeground, selectionWrites: 7, current: .account, linkPending: false)
        XCTAssertTrue(later.handle(.draftLoaded, selectionWrites: 7, current: .account, linkPending: false))
    }

    /// The real router and navigation model, driven in the order a warm open
    /// through a link produces: the link is delivered and consumed, THEN the
    /// arrival lands. Send must not be selected over it.
    func testALinkConsumedBeforeTheArrivalKeepsItsDestination() async {
        let navigation = AppNavigationModel(selection: .account)
        let router = AppDeepLinkRouter()
        var arrivals = SharedDraftArrivalNavigation(selectionWrites: navigation.selectionWrites)
        _ = arrivals.handle(.leftForeground, selectionWrites: navigation.selectionWrites,
                            current: navigation.selection, linkPending: router.pending != nil)

        XCTAssertTrue(router.open(URL(string: "https://relayium.com/cross-network")!))
        guard let link = router.pending else { return XCTFail("link refused") }
        navigation.select(AppRouting.destination(for: link))   // what `deliver` does first
        router.consume(link)
        XCTAssertNil(router.pending)

        let moves = arrivals.handle(.draftLoaded, selectionWrites: navigation.selectionWrites,
                                    current: navigation.selection, linkPending: router.pending != nil)
        XCTAssertFalse(moves)
        XCTAssertEqual(navigation.selection, .pairingCode)
    }
}
