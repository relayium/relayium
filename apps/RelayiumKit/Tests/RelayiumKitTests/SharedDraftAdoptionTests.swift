import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// What the app does with a draft the share extension left: when it may be used,
/// what using it replaces, and when the extension's copy may finally be removed.
///
/// The retirement rule is the part with teeth. A shared draft is, for as long as
/// it exists, the user's only copy of what they shared other than whatever the
/// source app still holds — so removing it early loses data, and removing it late
/// offers the same files as a second send forever. The window is exactly "the
/// account-bound plan and its Keychain key are both committed", and a crash
/// inside that window has to be repaired by recovery.
@MainActor
final class SharedDraftAdoptionTests: XCTestCase {
    private var root: URL!
    private var drafts: SharedDraftStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("share-adopt-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        drafts = SharedDraftStore(root: root.appendingPathComponent("SharedDrafts"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - doubles and helpers

    private final class OKTransport: ResumableTransport, @unchecked Sendable {
        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            ("upload-1", 1 << 20)
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            .committed(received: to)
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            UploadResult(id: "stored-1", expiresAt: 99)
        }
    }

    private final class DroppingTransport: ResumableTransport, @unchecked Sendable {
        func initUpload(header: [UInt8], burnAfterRead: Bool, ttl: Int,
                        size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
            ("upload-1", 1 << 20)
        }
        func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                        total: Int, token: String,
                        onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome {
            throw CloudError.network
        }
        func uploadOffset(uploadId: String, token: String) async throws -> Int { throw CloudError.network }
        func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
            throw CloudError.network
        }
    }

    /// A pending-key store that cannot save. The failure this exists for is the
    /// one where the draft MUST survive: without a key, nothing could ever open
    /// what was staged.
    private final class UnsavableKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        func save(id: String, keyB64url: String) async throws { throw KeychainError.status(-25308) }
        func key(for id: String) async throws -> String? { nil }
        func remove(id: String) async throws {}
    }

    private func stageDraft(_ layout: [String: String] = ["shared.txt": "shared"],
                            named: String = "shared.txt") throws -> SharedDraftPlan {
        let source = root.appendingPathComponent("source-\(UUID().uuidString)")
        for (path, contents) in layout {
            let file = source.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try Data(contents.utf8).write(to: file)
        }
        let writer = try drafts.beginDraft()
        try writer.adopt(source.appendingPathComponent(named), suggestedName: named)
        return try writer.publish()
    }

    private func makeUpload(transport: ResumableTransport = OKTransport(),
                            pendingKeys: StoredLinkKeyStore = InMemoryStoredLinkKeyStore(),
                            store: PendingUploadStore? = nil) -> CloudUploadModel {
        let model = CloudUploadModel(
            uploader: CloudUploader(transport: transport),
            keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://relayium.com",
            pending: PendingUploadSupport(
                store: store ?? PendingUploadStore(root: root.appendingPathComponent("PendingUploads")),
                keys: pendingKeys, drafts: drafts))
        model.accountId = "acct-1"
        return model
    }

    private func makeSend(upload: CloudUploadModel,
                          session: CurrentValueSubject<SessionState, Never>) -> SendSelectionModel {
        let model = SendSelectionModel(
            upload: upload,
            photos: PhotoStagingArea(root: root.appendingPathComponent("photos")),
            inbox: root.appendingPathComponent("inbox"),
            drafts: drafts,
            fetchConfig: { ServerConfig(maxFileSize: 0) })
        model.observe(session)
        return model
    }

    /// Let the account event installed by `makeSend` finish.
    ///
    /// A ready session drives `recoverPendingJob`, which parks the upload model
    /// in `.checkingRecovery` while it scans the disk — and `.checkingRecovery`
    /// is deliberately a refusal state for adoption. A test that acted before it
    /// landed would be asserting against a surface that is legitimately busy.
    private func settled(_ upload: CloudUploadModel) async {
        await upload.recoveryTask?.value
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

    // MARK: - what the Send surface shows

    /// Visible while SIGNED OUT, with a truthful reason it cannot be used.
    ///
    /// The extension can be used from any app at any time, including on a device
    /// nobody has signed in on, and it tells the user their files are waiting in
    /// Relayium. A Send tab that showed nothing until they signed in would have
    /// made that sentence false for exactly the person most likely to be
    /// confused by it.
    func testAWaitingDraftIsVisibleAndRefusedWhileSignedOut() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(.loggedOut)
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.refreshSharedDrafts()
        await waitUntil { !send.sharedDrafts.isEmpty }

        XCTAssertEqual(send.sharedDrafts.map(\.id), [plan.id])
        XCTAssertEqual(send.sharedDrafts.first?.fileCount, 1)

        send.useSharedDraft(plan.id)
        XCTAssertEqual(send.sharedDraftRefusal,
                       SharedDraftRefusalNotice(draftId: plan.id, reason: .needsAccount))
        XCTAssertNil(send.adoptedDraft)
        XCTAssertEqual(upload.state, .idle, "a signed-out adopt must change nothing")
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id], "and must not remove it")
    }

    /// A refusal belongs to the draft whose button was pressed, and to no other.
    ///
    /// The Send tab draws one card per waiting draft. A refusal held as a bare
    /// reason has no way of saying which card asked for it, so pressing "Use
    /// these files" on one draft printed "sign in first" under every one of them
    /// — four drafts reading as refused for a reason nobody gave them.
    func testARefusalIsScopedToTheDraftWhoseButtonWasPressed() async throws {
        let first = try stageDraft(["one.txt": "one"], named: "one.txt")
        let second = try stageDraft(["two.txt": "two"], named: "two.txt")
        let session = CurrentValueSubject<SessionState, Never>(.loggedOut)
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.refreshSharedDrafts()
        await waitUntil { send.sharedDrafts.count == 2 }

        send.useSharedDraft(second.id)

        let notice = try XCTUnwrap(send.sharedDraftRefusal)
        XCTAssertEqual(notice.reason, .needsAccount)
        XCTAssertTrue(notice.applies(to: second.id))
        XCTAssertFalse(notice.applies(to: first.id),
                       "one draft's refusal was rendered under another draft's card")

        // And pressing the other one moves it rather than accumulating.
        send.useSharedDraft(first.id)
        let moved = try XCTUnwrap(send.sharedDraftRefusal)
        XCTAssertTrue(moved.applies(to: first.id))
        XCTAssertFalse(moved.applies(to: second.id))
    }

    func testTheRefusalCopyExistsInEveryLanguageAndNamesTheReason() {
        for language in AppLanguage.allCases {
            for refusal in [SharedDraftRefusal.needsAccount, .busy] {
                let message = SharedDraftGate.message(for: refusal, language: language)
                XCTAssertFalse(message.isEmpty)
                XCTAssertFalse(message.contains("share."), "\(refusal) renders a raw key in \(language)")
            }
            let body = SharedDraftGate.waitingBody(fileCount: 3, language: language)
            XCTAssertFalse(body.contains("%@"), "the waiting line left a placeholder in \(language)")
            XCTAssertFalse(body.contains("share.waiting"))
        }
    }

    /// The gate is the decision, and `.idle` is the only state that admits one.
    /// Everything else is either work in flight, a job the user has not answered
    /// for, a result they may not have copied, a failure they are reading, or a
    /// selection they made by hand.
    func testOnlyAnIdleSendSurfaceAdmitsADraft() {
        XCTAssertNil(SharedDraftGate.refusal(hasReadyAccount: true, upload: .idle))
        XCTAssertEqual(SharedDraftGate.refusal(hasReadyAccount: false, upload: .idle),
                       .needsAccount)
        for occupied: UploadState in [
            .picked([SelectedFile(url: URL(fileURLWithPath: "/tmp/a"), relativePath: "a")]),
            .checkingRecovery, .preparing, .uploading(sent: 1, total: 2), .restarting,
            .interrupted(files: 1, bytes: 2, message: nil),
            .done(link: "l", expiresAt: 1, keyWarning: nil),
            .failed("nope"),
        ] {
            XCTAssertEqual(SharedDraftGate.refusal(hasReadyAccount: true, upload: occupied),
                           .busy, "\(occupied) admitted a draft over the top of it")
        }
    }

    func testAnUnrelatedSelectionIsNeverOverwritten() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        let picked = root.appendingPathComponent("picked.bin")
        try Data("picked".utf8).write(to: picked)
        upload.pick(FileSelection(files: [SelectedFile(url: picked, relativePath: "picked.bin")],
                                  emptyDirectories: []))

        send.useSharedDraft(plan.id)

        XCTAssertEqual(send.sharedDraftRefusal,
                       SharedDraftRefusalNotice(draftId: plan.id, reason: .busy))
        XCTAssertNil(send.adoptedDraft)
        guard case let .picked(files) = upload.state else {
            return XCTFail("the user's own selection was replaced: \(upload.state)")
        }
        XCTAssertEqual(files.map(\.relativePath), ["picked.bin"])
        XCTAssertNil(upload.sourceDraftId)
    }

    // MARK: - the hand-off: the scene becoming active

    /// **This is the whole hand-off from the share extension.**
    ///
    /// A Share Extension may not open its containing app — Apple documents
    /// `NSExtensionContext.open` as the Today and iMessage extension points'
    /// method — so nothing pushes a staged draft onto this screen. What brings
    /// it there is the user opening or returning to Relayium, and this is the
    /// decision that turns that into a read. It lives in the model rather than
    /// in the scene root precisely so it can be asserted here.
    func testTheInboxIsReReadWheneverTheSceneBecomesActive() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)
        XCTAssertEqual(send.sharedDrafts, [])

        // Staged while the app was elsewhere — which is the normal case, since
        // the user was in another app when they shared it.
        let plan = try stageDraft()
        send.phaseChanged(to: .inactive)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(send.sharedDrafts, [],
                       "`.inactive` is a picker being up, not the user coming back")

        send.phaseChanged(to: .active)
        await waitUntil { !send.sharedDrafts.isEmpty }
        XCTAssertEqual(send.sharedDrafts.map(\.id), [plan.id])

        // And it stays a pure read: nothing is adopted, selected or uploaded by
        // the app simply being brought forward.
        XCTAssertNil(send.adoptedDraft)
        XCTAssertNil(upload.sourceDraftId)
        XCTAssertEqual(upload.state, .idle)

        // `.background` is not a read either — there is nobody to show it to.
        send.discardSharedDraft(plan.id)
        await waitUntil { send.sharedDrafts.isEmpty }
        send.phaseChanged(to: .background)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(send.sharedDrafts, [])
    }

    // MARK: - adopting

    func testAdoptingSelectsTheStagedCopiesUnderTheirManifestNames() async throws {
        let plan = try stageDraft(["trip/a.txt": "one", "trip/deep/b.txt": "two"], named: "trip")
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)

        XCTAssertEqual(send.adoptedDraft?.id, plan.id)
        XCTAssertEqual(upload.sourceDraftId, plan.id)
        guard case let .picked(files) = upload.state else {
            return XCTFail("expected a selection, got \(upload.state)")
        }
        // Hierarchy rides in the manifest name, exactly as for a picked folder.
        XCTAssertEqual(files.map(\.relativePath), ["trip/a.txt", "trip/deep/b.txt"])
        XCTAssertEqual(files.map(\.byteCount), [3, 3])
        XCTAssertEqual(send.selectedFiles, files)
        // And the URLs are the STAGED copies, never anything the extension saw.
        for file in files {
            XCTAssertTrue(file.url.path.hasPrefix(drafts.draftURL(id: plan.id).path),
                          "the app is sending from outside the draft: \(file.url.path)")
        }
        XCTAssertTrue(send.summary?.contains("6 B") == true,
                      "an adopted draft must describe its total size on screen")
        // Out of the offered list, because it is now the selection: offering it
        // again would be the same files twice.
        XCTAssertEqual(send.sharedDrafts, [])
        // And still on disk. Adoption is not a commitment.
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id])
    }

    /// Every way of replacing the selection returns the draft rather than losing
    /// it — including the destructive-sounding one.
    func testClearingAnAdoptedDraftReturnsItToTheInbox() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        XCTAssertEqual(send.adoptedDraft?.id, plan.id)

        send.clear()
        await waitUntil { !send.sharedDrafts.isEmpty }

        XCTAssertNil(send.adoptedDraft)
        XCTAssertNil(upload.sourceDraftId, "a cleared selection must not still claim a source")
        XCTAssertEqual(send.sharedDrafts.map(\.id), [plan.id])
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id])
    }

    func testChoosingFilesReturnsAnAdoptedDraft() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        let picked = root.appendingPathComponent("picked.bin")
        try Data("picked".utf8).write(to: picked)
        send.chooseFiles(.success([picked]))
        await waitUntil { !send.sharedDrafts.isEmpty }

        XCTAssertNil(send.adoptedDraft)
        XCTAssertNil(upload.sourceDraftId)
        XCTAssertEqual(send.sharedDrafts.map(\.id), [plan.id])
    }

    /// Leaving or switching account returns an uncommitted draft to the inbox.
    /// It is never silently assigned to whoever signs in next: the draft belongs
    /// to the DEVICE, and the next person has to choose it themselves.
    func testAnAccountSwitchReturnsAnUncommittedDraftRatherThanCarryingIt() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready("acct-1"))
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        XCTAssertEqual(send.adoptedDraft?.id, plan.id)

        session.send(ready("acct-2"))

        // SYNCHRONOUSLY: there must be no runloop turn in which the new account
        // is signed in and still holding the previous one's selection.
        XCTAssertNil(send.adoptedDraft)
        XCTAssertNil(upload.sourceDraftId)
        XCTAssertEqual(upload.state, .checkingRecovery)

        await waitUntil { !send.sharedDrafts.isEmpty }
        XCTAssertEqual(send.sharedDrafts.map(\.id), [plan.id],
                       "the draft must go back to the inbox, not follow the account")
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id], "and must not be deleted")
    }

    func testSigningOutKeepsTheDraftVisibleAndUnowned() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        session.send(.loggedOut)
        await waitUntil { !send.sharedDrafts.isEmpty }

        XCTAssertNil(send.adoptedDraft)
        XCTAssertEqual(send.sharedDrafts.map(\.id), [plan.id])
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id])
    }

    // MARK: - discarding

    func testDiscardRemovesExactlyTheChosenDraftAndItsBytes() async throws {
        let keep = try stageDraft(["keep.txt": "keep"], named: "keep.txt")
        let go = try stageDraft(["go.txt": "go"], named: "go.txt")
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.refreshSharedDrafts()
        await waitUntil { send.sharedDrafts.count == 2 }

        send.discardSharedDraft(go.id)
        await waitUntil { send.sharedDrafts.count == 1 }

        XCTAssertEqual(send.sharedDrafts.map(\.id), [keep.id])
        XCTAssertEqual(drafts.drafts().map(\.id), [keep.id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: drafts.draftURL(id: go.id).path))
    }

    /// Discard issues two reads — one for the selection it clears, one after the
    /// removal — and two disk listings in flight can finish in either order. The
    /// older one must not publish last and put the deleted draft back on screen.
    func testAnOlderInboxListingNeverPublishesOverANewerOne() async throws {
        let keep = try stageDraft(["keep.txt": "keep"], named: "keep.txt")
        let go = try stageDraft(["go.txt": "go"], named: "go.txt")
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        // A read started BEFORE the removal, then the removal and its own read.
        send.refreshSharedDrafts()
        drafts.discard(id: go.id)
        send.refreshSharedDrafts()
        await waitUntil { send.sharedDrafts.count == 1 }
        // Long enough for the earlier listing to have landed if it were going to.
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(send.sharedDrafts.map(\.id), [keep.id],
                       "a stale listing republished a discarded draft")
    }

    /// Discarding the draft that is currently selected clears the selection
    /// first — otherwise Send would be offered for bytes that are gone.
    func testDiscardingTheAdoptedDraftAlsoClearsTheSelection() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUpload()
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        send.discardSharedDraft(plan.id)
        await waitUntil { send.sharedDrafts.isEmpty }

        XCTAssertNil(send.adoptedDraft)
        XCTAssertNil(upload.sourceDraftId)
        XCTAssertEqual(upload.state, .idle)
        XCTAssertNil(send.summary)
        XCTAssertEqual(drafts.drafts(), [])
    }

    // MARK: - retirement: only after the job is durable

    /// The whole rule, in one pass: the plan records the source, the draft is
    /// gone once the plan and its key are both committed, and no second offer
    /// survives.
    func testTheSourceIsRetiredOnlyAfterThePlanAndItsKeyAreCommitted() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        upload.start(token: "t")
        await upload.task?.value

        guard case .done = upload.state else {
            return XCTFail("expected a finished upload, got \(upload.state)")
        }
        XCTAssertEqual(drafts.drafts(), [], "the source draft was never retired")
        send.refreshSharedDrafts()
        await waitUntil { true }
        XCTAssertEqual(send.sharedDrafts, [], "a sent draft came back as a second offer")
    }

    /// The pending plan records the source, so a later process can finish the
    /// retirement the first one may not have reached.
    func testTheDurablePlanCarriesTheSourceDraftId() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(transport: DroppingTransport(), store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        upload.start(token: "t")
        await upload.task?.value

        let pending = try XCTUnwrap(pendingStore.plan(for: "acct-1"))
        XCTAssertEqual(pending.sourceDraftId, plan.id)
        // The job is durable — plan on disk, key in the store — so the draft is
        // already redundant even though the upload itself failed. An upload can
        // be resumed days later, and a draft waiting through all of that would
        // be a second, separate send of the same files.
        XCTAssertEqual(drafts.drafts(), [])
    }

    /// The failure in which the draft is the user's ONLY copy: the key could not
    /// be saved, so the staged job is unrecoverable and is purged. The draft must
    /// survive and be offered again.
    func testAFailedKeySaveKeepsTheDraftAndReOffersIt() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(pendingKeys: UnsavableKeyStore(), store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        upload.start(token: "t")
        await upload.task?.value

        guard case .failed = upload.state else {
            return XCTFail("expected a failure, got \(upload.state)")
        }
        XCTAssertNil(pendingStore.plan(for: "acct-1"), "an unrecoverable job must not be kept")
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id],
                       "the user's only copy was deleted for a job that cannot be resumed")

        // It is still the SELECTION, which is what makes the failure's own
        // remedy work: Try again re-prepares from the same staged bytes rather
        // than making the user go back to the app they shared from. That is
        // also why it is not in the offered list — it is not waiting, it is
        // chosen.
        XCTAssertEqual(send.adoptedDraft?.id, plan.id)
        XCTAssertEqual(upload.sourceDraftId, plan.id)
        send.refreshSharedDrafts()
        await waitUntil { true }
        XCTAssertEqual(send.sharedDrafts, [])

        // And letting go of it puts it back, rather than losing it.
        upload.reset()
        send.clear()
        await waitUntil { !send.sharedDrafts.isEmpty }
        XCTAssertEqual(send.sharedDrafts.map(\.id), [plan.id])
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id])
    }

    /// A crash between "the key is saved" and "the draft is removed" leaves a
    /// job that is complete and a draft that still looks waiting. Validated
    /// recovery finishes the retirement — idempotently, and only after the key
    /// itself has been proved readable.
    func testRecoveryIdempotentlyRetiresASourceACrashLeftBehind() async throws {
        let plan = try stageDraft()
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let pendingKeys = InMemoryStoredLinkKeyStore()

        // Exactly the on-disk state that crash leaves: a valid, key-bearing
        // pending job naming a draft that is still there.
        let source = root.appendingPathComponent("crash.bin")
        try Data("crash".utf8).write(to: source)
        let job = try pendingStore.prepare(
            files: [SelectedFile(url: source, relativePath: "crash.bin")],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600, sourceDraftId: plan.id)
        try await pendingKeys.save(id: job.jobId, keyB64url: encodeStoreKey(generateStoreKey()))
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id])

        let upload = makeUpload(pendingKeys: pendingKeys, store: pendingStore)
        upload.recoverPendingJob(for: "acct-1")
        await upload.recoveryTask?.value

        guard case .interrupted = upload.state else {
            return XCTFail("the recovered job must still be offered, got \(upload.state)")
        }
        XCTAssertEqual(drafts.drafts(), [],
                       "recovery left a retired draft offering the same files a second time")

        // Idempotent: a second recovery over a draft that is already gone is a
        // no-op rather than a failure, and does not disturb the job.
        let second = makeUpload(pendingKeys: pendingKeys, store: pendingStore)
        second.recoverPendingJob(for: "acct-1")
        await second.recoveryTask?.value
        guard case .interrupted = second.state else {
            return XCTFail("a second recovery changed the offer: \(second.state)")
        }
    }

    /// A job whose key CANNOT be read is not durable, so its source must stay.
    func testRecoveryKeepsTheSourceWhenTheKeyIsGone() async throws {
        let plan = try stageDraft()
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let source = root.appendingPathComponent("orphan.bin")
        try Data("orphan".utf8).write(to: source)
        _ = try pendingStore.prepare(
            files: [SelectedFile(url: source, relativePath: "orphan.bin")],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600, sourceDraftId: plan.id)

        // No key was ever saved — the crash landed one line earlier.
        let upload = makeUpload(pendingKeys: InMemoryStoredLinkKeyStore(), store: pendingStore)
        upload.recoverPendingJob(for: "acct-1")
        await upload.recoveryTask?.value

        XCTAssertEqual(upload.state, .idle, "a keyless job must not be offered")
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id],
                       "the source of an unusable job is the user's only copy and must stay")
    }

    // MARK: - retirement when the account has already left

    /// A meeting point for the test and the suspended Keychain read, so the
    /// account can be made to leave at exactly the moment the read is parked.
    /// Nothing here sleeps or polls: the test waits for the read to announce it
    /// has arrived, and the read waits to be let go.
    private actor KeyReadGate {
        private var entered = false
        private var released = false
        private var arrival: CheckedContinuation<Void, Never>?
        private var departure: CheckedContinuation<Void, Never>?

        /// Called from inside `key(for:)`: announce the suspension, then park.
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

    /// A pending-key store whose read parks until the test lets it go and then
    /// answers as though nothing had happened.
    ///
    /// **The point is that it never looks at `Task.isCancelled`,** which is not
    /// a contrived double: `SecItemCopyMatching` is a synchronous C call, and a
    /// store built around it returns the value it fetched no matter what
    /// happened to the Swift task while it was in flight. Recovery therefore
    /// cannot assume that being cancelled mid-read means it never resumes.
    ///
    /// Everything it holds is immutable, so the cleanup that runs concurrently
    /// with the parked read cannot race it.
    private final class GatedKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        let gate = KeyReadGate()
        private let stored: String

        init(returning stored: String) { self.stored = stored }

        func save(id: String, keyB64url: String) async throws {}
        func key(for id: String) async throws -> String? {
            await gate.arriveAndWait()
            return stored
        }
        func remove(id: String) async throws {}
    }

    /// **The stale recovery must not be able to delete anything.**
    ///
    /// Cold recovery validates the account and the generation, then suspends on
    /// the Keychain read. While it is parked the account leaves: the generation
    /// moves on and the account-bound job is purged. A key store that does not
    /// observe cancellation then hands the old key to the superseded task — and
    /// the plan it is holding still names a shared draft that, now that the job
    /// backing it is gone, is once again the only copy of those files on the
    /// device.
    ///
    /// So the retirement must be behind the generation check rather than in
    /// front of it. Reversed, the user signs out and the files they shared are
    /// deleted with nothing left that could have sent them.
    func testARecoverySupersededByAnAccountExitRetiresNothing() async throws {
        let draft = try stageDraft()
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let source = root.appendingPathComponent("crash.bin")
        try Data("crash".utf8).write(to: source)
        _ = try pendingStore.prepare(
            files: [SelectedFile(url: source, relativePath: "crash.bin")],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600, sourceDraftId: draft.id)

        let keys = GatedKeyStore(returning: encodeStoreKey(generateStoreKey()))
        let upload = makeUpload(pendingKeys: keys, store: pendingStore)
        var consumed: [String] = []
        upload.onSourceDraftConsumed = { consumed.append($0) }

        upload.recoverPendingJob(for: "acct-1")
        let recovery = try XCTUnwrap(upload.recoveryTask, "recovery never started")

        // The read is genuinely suspended: recovery has passed its first
        // account and generation check and is waiting on the Keychain.
        await keys.gate.waitUntilEntered()
        XCTAssertEqual(upload.state, .checkingRecovery,
                       "the test released the gate before recovery reached the key read")

        // The account leaves in that window. The job is account-bound, so it
        // goes; the draft is device-owned, so it stays.
        upload.purgePendingJob()
        await upload.cleanupTask?.value
        XCTAssertNil(pendingStore.plan(for: "acct-1"), "the outgoing account's job was kept")

        // And now the read that cancellation did not stop comes back.
        await keys.gate.release()
        await recovery.value

        XCTAssertEqual(drafts.drafts().map(\.id), [draft.id],
                       "a superseded recovery deleted the user's only remaining copy")
        XCTAssertNotNil(drafts.draft(id: draft.id), "the draft survived as an unusable husk")
        XCTAssertTrue(FileManager.default.fileExists(atPath: drafts.draftURL(id: draft.id).path),
                      "the draft's bytes were deleted")
        XCTAssertFalse(FileManager.default.fileExists(atPath: drafts.retiredURL(id: draft.id).path),
                       "the draft was logically retired even though its bytes survived")
        XCTAssertEqual(consumed, [], "a superseded recovery announced a retirement it must not make")

        // It repaints nothing either: the screen belongs to whatever replaced it.
        XCTAssertEqual(upload.state, .idle, "a superseded recovery repainted the screen")
        XCTAssertNil(upload.cleanupWarning)

        // The draft is still a real offer, which is the whole point of keeping it.
        let send = makeSend(upload: upload,
                            session: CurrentValueSubject<SessionState, Never>(.loggedOut))
        send.refreshSharedDrafts()
        await waitUntil { !send.sharedDrafts.isEmpty }
        XCTAssertEqual(send.sharedDrafts.map(\.id), [draft.id],
                       "the surviving draft was no longer offered")
    }

    // MARK: - retirement when the filesystem refuses

    /// A `FileManager` that will not delete anything under a given path.
    ///
    /// `EPERM` on `unlink` is not something a test can arrange for real, and it
    /// is the case the whole logical-retirement design exists for: the app has
    /// durably taken ownership of the bytes and the removal fails anyway.
    private final class UnremovableFileManager: FileManager, @unchecked Sendable {
        var refusedPrefix: String?
        override func removeItem(at url: URL) throws {
            if let refusedPrefix, url.path.hasPrefix(refusedPrefix) {
                throw CocoaError(.fileWriteNoPermission)
            }
            try super.removeItem(at: url)
        }
    }

    /// **The invariant with teeth: one durable job, one send.**
    ///
    /// The plan and its Keychain key are committed, so the draft is redundant —
    /// and then `removeItem` fails. `retireSourceDraft` used to discard that
    /// result, which meant the draft stayed in the inbox and the same files were
    /// offered as a second, separate send forever. Worse, once the upload
    /// finished and purged its pending bytes, the plan carrying `sourceDraftId`
    /// went with them: the only pointer that could ever have retried the cleanup.
    ///
    /// What must happen instead: the retirement is recorded durably BEFORE
    /// anything is deleted, the draft is gone from the inbox whatever the
    /// filesystem does, the upload still succeeds and still produces its link,
    /// and the leftover bytes are reported through the ordinary cleanup warning
    /// and reclaimed on the next launch.
    func testAFailedSourceRemovalNeverReOffersTheDraftAndIsRetriedOnRelaunch() async throws {
        let manager = UnremovableFileManager()
        drafts = SharedDraftStore(root: root.appendingPathComponent("SharedDrafts"),
                                  fileManager: manager)
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        // From here nothing under this draft can be deleted.
        manager.refusedPrefix = drafts.draftURL(id: plan.id).path

        upload.start(token: "t")
        await upload.task?.value

        // The upload SUCCEEDED. A cleanup that could not finish is not a failed
        // transfer, and turning it into one would be this app refusing to send
        // files it has already sent.
        guard case let .done(link, _, _) = upload.state else {
            return XCTFail("a cleanup failure became an upload failure: \(upload.state)")
        }
        XCTAssertFalse(link.isEmpty)
        XCTAssertEqual(upload.cleanupWarning, L10n.t(.uploadCleanupFailed),
                       "leftover bytes were never reported")

        // And the draft is GONE from the inbox, though its bytes are not.
        XCTAssertEqual(drafts.drafts(), [])
        send.refreshSharedDrafts()
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(send.sharedDrafts, [],
                       "a draft whose removal failed came back as a second send")
        XCTAssertTrue(FileManager.default.fileExists(atPath: drafts.draftURL(id: plan.id).path),
                      "the test did not actually leave any bytes behind")

        // Relaunch. The app's launch sweep retries the physical half, and the
        // pointer that lets it is in the draft store rather than in the pending
        // plan — which this upload has already purged.
        XCTAssertNil(pendingStore.plan(for: "acct-1"),
                     "the successful upload should have purged its pending bytes")
        let relaunchedUpload = makeUpload(store: pendingStore)
        let relaunched = SendSelectionModel(
            upload: relaunchedUpload,
            photos: PhotoStagingArea(root: root.appendingPathComponent("photos2")),
            inbox: root.appendingPathComponent("inbox2"),
            drafts: SharedDraftStore(root: root.appendingPathComponent("SharedDrafts")),
            fetchConfig: { ServerConfig(maxFileSize: 0) })
        relaunched.refreshSharedDrafts()
        await waitUntil { !FileManager.default.fileExists(atPath: drafts.draftURL(id: plan.id).path) }

        XCTAssertFalse(FileManager.default.fileExists(atPath: drafts.draftURL(id: plan.id).path),
                       "the leftover bytes were never reclaimed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: drafts.retiredURL(id: plan.id).path),
                       "the record outlived the bytes it was hiding")
        XCTAssertEqual(relaunched.sharedDrafts, [])
    }

    /// The same failure during validated recovery: a crash left the job, the key
    /// proves it durable, and the removal still fails. The draft must be hidden
    /// and the job must still be offered.
    func testRecoveryHidesASourceItCannotDeleteAndStillOffersTheJob() async throws {
        let manager = UnremovableFileManager()
        drafts = SharedDraftStore(root: root.appendingPathComponent("SharedDrafts"),
                                  fileManager: manager)
        let plan = try stageDraft()
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let source = root.appendingPathComponent("crash.bin")
        try Data("crash".utf8).write(to: source)
        let job = try pendingStore.prepare(
            files: [SelectedFile(url: source, relativePath: "crash.bin")],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600, sourceDraftId: plan.id)
        try await pendingKeys.save(id: job.jobId, keyB64url: encodeStoreKey(generateStoreKey()))
        manager.refusedPrefix = drafts.draftURL(id: plan.id).path

        let upload = makeUpload(pendingKeys: pendingKeys, store: pendingStore)
        upload.recoverPendingJob(for: "acct-1")
        await upload.recoveryTask?.value

        guard case .interrupted = upload.state else {
            return XCTFail("the recovered job must still be offered, got \(upload.state)")
        }
        XCTAssertEqual(upload.cleanupWarning, L10n.t(.uploadCleanupFailed))
        XCTAssertEqual(drafts.drafts(), [],
                       "recovery re-offered a source it had already taken ownership of")
    }

    // MARK: - what the screen returns to once the draft is gone
    //
    // Retirement deletes the very bytes the selection describes. `reset()`,
    // `cancel()`, `restore()` and `discard()` all return to `.picked(lastPicked)`
    // — so unless the retirement drops that selection, both buttons the user can
    // reach afterwards hand them back a list of files this process has deleted,
    // under a summary line counting them, with Send offered over the top.

    /// **Send another, after a shared draft has actually been sent.**
    ///
    /// The job became durable, the draft was retired, the upload finished. There
    /// is nothing left to send a second time: the staged copies are gone and the
    /// account-bound job that replaced them has been purged too. So the screen
    /// has to come back empty — no summary, no adopted draft, no claimed source,
    /// and above all no selection pointing into a directory that no longer
    /// exists.
    func testSendAnotherAfterASentDraftReturnsAnEmptyScreen() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        let staged = try XCTUnwrap(drafts.stagedFiles(for: plan).first?.url)
        upload.start(token: "t")
        await upload.task?.value

        guard case .done = upload.state else {
            return XCTFail("expected a finished upload, got \(upload.state)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path),
                       "this test proves nothing unless the staged bytes really went")
        // The retirement itself is the moment the selection stops existing, not
        // the button afterwards: those bytes are gone whether or not anybody
        // presses one.
        XCTAssertNil(send.adoptedDraft, "a consumed draft is still described on screen")
        XCTAssertNil(send.summary)
        XCTAssertNil(upload.sourceDraftId)

        send.resetUpload()

        XCTAssertEqual(upload.state, .idle,
                       "Send another returned to a selection of deleted files: \(upload.state)")
        XCTAssertNil(send.adoptedDraft)
        XCTAssertNil(send.summary, "a summary line survived the files it counts")
        XCTAssertNil(upload.sourceDraftId)
        send.refreshSharedDrafts()
        // Long enough for a listing to have landed if one were going to.
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(send.sharedDrafts, [], "a sent draft came back as a second offer")
    }

    /// **Discard, for an interrupted upload of a shared draft, in the same
    /// launch that adopted it.**
    ///
    /// Both copies are now gone — the draft when the job became durable, the job
    /// when the user pressed Discard — so this is the one Discard in the app
    /// after which there is genuinely nothing left. Returning to `.picked` here
    /// would offer Send over two deletions at once.
    func testDiscardingAnInterruptedDraftUploadLeavesNothingBehind() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(transport: DroppingTransport(), store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        let staged = try XCTUnwrap(drafts.stagedFiles(for: plan).first?.url)
        upload.start(token: "t")
        await upload.task?.value

        guard case .interrupted = upload.state else {
            return XCTFail("expected a resumable job, got \(upload.state)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path),
                       "the durable job should already own these bytes")

        send.discardPendingUpload()
        await upload.cleanupTask?.value

        XCTAssertEqual(upload.state, .idle,
                       "Discard returned to a selection of deleted files: \(upload.state)")
        XCTAssertNil(send.adoptedDraft)
        XCTAssertNil(send.summary, "a summary line survived the files it counts")
        XCTAssertNil(upload.sourceDraftId)
        XCTAssertNil(pendingStore.plan(for: "acct-1"), "the discarded job is still on disk")
        XCTAssertEqual(drafts.drafts(), [])
        send.refreshSharedDrafts()
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(send.sharedDrafts, [],
                       "a discarded job's retired source came back as an offer")
    }

    /// The failure BEFORE durable adoption keeps everything, and Try again is
    /// why. The key could not be saved, so the staged job was purged and the
    /// draft is the user's only remaining copy — clearing it here would be this
    /// app deleting the last of something on the way to offering a retry of it.
    func testTryAgainAfterAFailedKeySaveStillHasTheDraftSelected() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(pendingKeys: UnsavableKeyStore(), store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        send.useSharedDraft(plan.id)
        upload.start(token: "t")
        await upload.task?.value

        guard case .failed = upload.state else {
            return XCTFail("expected a failure, got \(upload.state)")
        }

        send.resetUpload()

        guard case let .picked(files) = upload.state else {
            return XCTFail("Try again threw away the only remaining copy: \(upload.state)")
        }
        XCTAssertEqual(files.map(\.relativePath), ["shared.txt"])
        for file in files {
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.url.path),
                          "Try again is offering a file that is not there")
        }
        XCTAssertEqual(send.adoptedDraft?.id, plan.id)
        XCTAssertEqual(upload.sourceDraftId, plan.id)
        XCTAssertNotNil(send.summary)
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id])
    }

    /// Relaunched recovery: the job's source is retired by a process that never
    /// adopted anything. There is no selection to forget, and Discard afterwards
    /// still has to leave a clean screen.
    func testRelaunchedRecoveryDiscardsToAnEmptyScreenWithNothingAdopted() async throws {
        let plan = try stageDraft()
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let pendingKeys = InMemoryStoredLinkKeyStore()
        let source = root.appendingPathComponent("crash.bin")
        try Data("crash".utf8).write(to: source)
        let job = try pendingStore.prepare(
            files: [SelectedFile(url: source, relativePath: "crash.bin")],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600, sourceDraftId: plan.id)
        try await pendingKeys.save(id: job.jobId, keyB64url: encodeStoreKey(generateStoreKey()))

        // A COLD model: `accountId` unset, exactly as at launch, so the session
        // becoming ready is what drives recovery rather than a field a test set.
        let upload = CloudUploadModel(
            uploader: CloudUploader(transport: DroppingTransport()),
            keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://relayium.com",
            pending: PendingUploadSupport(store: pendingStore, keys: pendingKeys, drafts: drafts))
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        guard case .interrupted = upload.state else {
            return XCTFail("the recovered job must still be offered, got \(upload.state)")
        }
        XCTAssertNil(send.adoptedDraft, "recovery adopted a draft this launch never chose")
        XCTAssertNil(send.summary)
        XCTAssertEqual(drafts.drafts(), [], "recovery left the retired source offered")
        // Without an explicit refresh: retiring a source is a change to what is
        // waiting, and the listing published before recovery ran still had it.
        await waitUntil { send.sharedDrafts.isEmpty }
        XCTAssertEqual(send.sharedDrafts, [],
                       "the Send tab still offers a draft recovery has taken ownership of")

        send.discardPendingUpload()
        await upload.cleanupTask?.value

        XCTAssertEqual(upload.state, .idle)
        XCTAssertNil(send.summary)
        XCTAssertNil(pendingStore.plan(for: "acct-1"))
        send.refreshSharedDrafts()
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(send.sharedDrafts, [])
    }

    // MARK: - the ordinary paths are unchanged

    /// A picker selection is the user's own file, still on their disk, and
    /// nothing was retired. Both buttons must still return to it — a Discard
    /// that emptied the screen here would make the user choose everything again
    /// for a job the app merely failed to finish.
    func testAnOrdinaryUploadStillReturnsToTheUsersOwnSelection() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(transport: DroppingTransport(), store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        let picked = root.appendingPathComponent("picked.bin")
        try Data("picked".utf8).write(to: picked)
        send.chooseFiles(.success([picked]))
        XCTAssertNotNil(send.summary)

        upload.start(token: "t")
        await upload.task?.value
        guard case .interrupted = upload.state else {
            return XCTFail("expected a resumable job, got \(upload.state)")
        }

        send.discardPendingUpload()
        await upload.cleanupTask?.value

        guard case let .picked(files) = upload.state else {
            return XCTFail("an ordinary Discard threw away the selection: \(upload.state)")
        }
        XCTAssertEqual(files.map(\.relativePath), ["picked.bin"])
        XCTAssertNotNil(send.summary, "the line describing the user's own files disappeared")
    }

    /// And Send another after an ordinary success keeps them too, which is the
    /// behaviour the name promises: another send of the same files.
    func testSendAnotherAfterAnOrdinaryUploadKeepsTheSelection() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(store: pendingStore)
        let send = makeSend(upload: upload, session: session)
        await settled(upload)

        let picked = root.appendingPathComponent("picked.bin")
        try Data("picked".utf8).write(to: picked)
        send.chooseFiles(.success([picked]))

        upload.start(token: "t")
        await upload.task?.value
        guard case .done = upload.state else {
            return XCTFail("expected a finished upload, got \(upload.state)")
        }

        send.resetUpload()

        guard case let .picked(files) = upload.state else {
            return XCTFail("Send another made the user choose again: \(upload.state)")
        }
        XCTAssertEqual(files.map(\.relativePath), ["picked.bin"])
        XCTAssertNotNil(send.summary)
    }

    /// A picker send records no source and retires nothing, and a plan written
    /// by the previous build still decodes and still resumes.
    func testOrdinarySendsRecordNoSourceAndLegacyPlansStillDecode() async throws {
        let plan = try stageDraft()
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let upload = makeUpload(transport: DroppingTransport(), store: pendingStore)

        let picked = root.appendingPathComponent("picked.bin")
        try Data("picked".utf8).write(to: picked)
        upload.pick(FileSelection(files: [SelectedFile(url: picked, relativePath: "picked.bin")],
                                  emptyDirectories: []))
        upload.start(token: "t")
        await upload.task?.value

        let job = try XCTUnwrap(pendingStore.plan(for: "acct-1"))
        XCTAssertNil(job.sourceDraftId, "a picker send must not claim a draft")
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id],
                       "an unrelated send retired somebody else's draft")

        // A v1 document, written before this field existed: the key is simply
        // absent. Bumping the version instead of adding an optional would have
        // made every interrupted upload on every existing install unresumable.
        let document = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try Data(contentsOf: pendingStore.planURL(for: job.jobId)))
                as? [String: Any])
        XCTAssertNil(document["sourceDraftId"],
                     "a plan with no draft behind it must encode nothing, so v1 stays byte-identical")
        var legacy = document
        legacy.removeValue(forKey: "sourceDraftId")
        try JSONSerialization.data(withJSONObject: legacy)
            .write(to: pendingStore.planURL(for: job.jobId))

        let reopened = try XCTUnwrap(pendingStore.plan(for: "acct-1"))
        XCTAssertEqual(reopened.jobId, job.jobId)
        XCTAssertNil(reopened.sourceDraftId)
        XCTAssertEqual(reopened.version, 1, "the version must not have moved")
    }

    /// A malformed draft id is refused before a byte is copied, and refused
    /// again on read. Ignoring it instead would leave the user's only other copy
    /// staged forever with nothing able to name it.
    func testAMalformedSourceDraftIdIsRefusedRatherThanIgnored() throws {
        let pendingStore = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        let source = root.appendingPathComponent("a.bin")
        try Data("a".utf8).write(to: source)
        XCTAssertThrowsError(try pendingStore.prepare(
            files: [SelectedFile(url: source, relativePath: "a.bin")],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600,
            sourceDraftId: "../../etc")) { error in
            XCTAssertEqual(error as? PendingUploadError, .unusableSelection)
        }

        let job = try pendingStore.prepare(
            files: [SelectedFile(url: source, relativePath: "a.bin")],
            accountId: "acct-1", burnAfterRead: false, ttl: 3600,
            sourceDraftId: SharedDraftID.make())
        var document = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try Data(contentsOf: pendingStore.planURL(for: job.jobId)))
                as? [String: Any])
        document["sourceDraftId"] = "not-a-draft"
        try JSONSerialization.data(withJSONObject: document)
            .write(to: pendingStore.planURL(for: job.jobId))
        XCTAssertNil(pendingStore.plan(for: "acct-1"),
                     "a plan naming an unusable draft was offered anyway")
    }
}
