import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// The main app's half of a device send: which devices may be offered, when a
/// selection becomes a durable delivery, what the user is told while it runs,
/// and which recovery a stopped one may offer.
///
/// `InboxSendCoordinatorTests` owns the wire and the durable state machine. What
/// is asserted HERE is the layer above it, and every test is about one of three
/// properties, because those are the three ways this screen could lie:
///
///  1. **An upload is not a delivery.** No local phase may be rendered as an
///     arrival, and the only thing that can produce `saved` is central saying a
///     target device committed the files.
///  2. **The account owns its work.** A delivery started under one account may
///     not run, be described, or retire anything under another — and leaving an
///     account must not DESTROY its plans, because the idempotency key inside
///     one is the only thing able to converge an ambiguous create.
///  3. **A draft is retired only after a durable, account-bound job owns its
///     bytes.** Early is data loss; late is the same files offered as a second
///     send forever.
@MainActor
final class InboxSendModelTests: XCTestCase {
    private var root: URL!
    private var store: PendingUploadStore!
    private var keys: InMemoryStoredLinkKeyStore!
    private var drafts: SharedDraftStore!
    private var sender: FakeInboxSenderTransport!
    private var objects: FakeStoredObjectService!
    private var transport: StubTransport!

    private let deviceID = "DEVICE0123456789"
    private let otherDeviceID = "DEVICE9876543210"
    private let currentDeviceID = "DEVICEcurrent999"
    private let keyID = "KEY0123456789abcd"
    private let taskID = "TASK0123456789ab"

    private var devicePublicKey = ""

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("p3a-model-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        keys = InMemoryStoredLinkKeyStore()
        drafts = SharedDraftStore(root: root.appendingPathComponent("SharedDrafts"))
        sender = FakeInboxSenderTransport()
        objects = FakeStoredObjectService()
        transport = StubTransport()
        transport.finalizeResult = UploadResult(id: "STORED0123456789", expiresAt: 4242)
        devicePublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        sender.deviceRows = [row(), currentRow()]
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - fixtures

    private func row(id: String? = nil, name: String = "Studio", kind: String = "mac",
                     autoAccept: InboxAutoAccept = .auto, revoked: Bool = false,
                     canReceive: Bool = true, presence: InboxPresence = .online,
                     receiveDirReady: Bool = true, registeredAt: Int64 = 10,
                     capability: String = InboxCapability.receiveV2,
                     presentsText: Bool = true,
                     isCurrent: Bool = false) -> InboxDeviceRow {
        let key = InboxKey(id: keyID, algorithm: InboxProtocol.keyAlgorithm,
                           publicKey: devicePublicKey, generation: 4, createdAt: 10)
        return InboxDeviceRow(id: id ?? deviceID, name: name, kind: kind, isCurrent: isCurrent,
                              inbox: InboxView(presence: presence, lastHeartbeatAt: 10,
                                               presenceExpiresAt: 100,
                                               heartbeatIntervalSeconds: 30, protocolVersion: 2,
                                               capabilities: InboxProtocol
                                                   .announcedCapabilities(presentingText: presentsText),
                                               receiveCapability: capability,
                                               autoAccept: autoAccept,
                                               receiveDirReady: receiveDirReady,
                                               revoked: revoked, canReceive: canReceive,
                                               registeredAt: registeredAt, key: key))
    }

    /// This very device, which the picker must never offer.
    private func currentRow() -> InboxDeviceRow {
        row(id: currentDeviceID, name: "This iPhone", kind: "app", isCurrent: true)
    }

    /// A row with no Device Inbox at all — a browser, or a build predating P1A.
    private func bareRow(id: String) -> InboxDeviceRow {
        InboxDeviceRow(id: id, name: "Browser", kind: "app", isCurrent: false, inbox: nil)
    }

    private func task(id: String? = nil, state: InboxTaskState = .queued,
                      idempotencyKey: String) -> InboxTask {
        InboxTask(id: id ?? taskID, targetDeviceID: deviceID, idempotencyKey: idempotencyKey,
                  storedFileID: "STORED0123456789", state: state, ciphertextBytes: 64,
                  targetKeyID: keyID, targetKeyGeneration: 4, expiresAt: 86_500)
    }

    /// Sleeps not at all, so a poll loop runs at the speed of the test.
    private final class NoSleep: InboxSleeping, @unchecked Sendable {
        func sleep(_ seconds: TimeInterval) async {}
        func wake() {}
    }

    private func makeModel(pendingKeys: StoredLinkKeyStore? = nil) -> InboxSendModel {
        InboxSendModel(
            pending: PendingUploadSupport(store: store, keys: pendingKeys ?? keys, drafts: drafts),
            uploader: CloudUploader(transport: transport),
            makeSender: { [sender] _ in sender! },
            objects: objects,
            sleeper: NoSleep(),
            pollSeconds: 0)
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

    private func selection(_ name: String = "a.txt") throws -> [SelectedFile] {
        let url = root.appendingPathComponent("origin-\(UUID().uuidString).txt")
        try Data("hello device inbox".utf8).write(to: url)
        return [SelectedFile(url: url, relativePath: name, byteCount: 18)]
    }

    private func waitUntil(_ what: String = "", timeout: Int = 600,
                           _ condition: @MainActor () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<timeout {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }

    /// A model already signed in with its device list read.
    private func signedIn(_ id: String = "acct-1",
                          pendingKeys: StoredLinkKeyStore? = nil)
        async -> (InboxSendModel, CurrentValueSubject<SessionState, Never>) {
        let session = CurrentValueSubject<SessionState, Never>(ready(id))
        let model = makeModel(pendingKeys: pendingKeys)
        model.observe(session)
        model.refreshTargets(token: "bearer-\(id)")
        await waitUntil("the device list") { model.directory == .loaded }
        return (model, session)
    }

    // MARK: - the target list

    /// Every device that may be OFFERED, blocked ones included — and never this
    /// one.
    ///
    /// Blocked rows staying is the whole point of a truthful list: a device whose
    /// owner turned receiving off is the device the user is looking for, and
    /// dropping it turns a two-second fix into "Relayium cannot see my Mac".
    func testTheListKeepsBlockedDevicesAndExcludesThisOne() async throws {
        sender.deviceRows = [row(), currentRow(),
                             row(id: otherDeviceID, name: "Desk", autoAccept: .off),
                             bareRow(id: "DEVICEbrowser999")]
        let (model, _) = await signedIn()

        XCTAssertEqual(model.candidates.map(\.id),
                       [deviceID, otherDeviceID, "DEVICEbrowser999"],
                       "the current device must not be offered as a target")
        XCTAssertEqual(model.candidates.map(\.isSendable), [true, false, false])
        XCTAssertEqual(model.candidates.first { $0.id == otherDeviceID }?.availability.block,
                       .receiveOff)
        XCTAssertEqual(model.candidates.first { $0.id == "DEVICEbrowser999" }?.availability.block,
                       .notEnrolled)
    }

    /// A rejected credential and an unreachable server are different facts with
    /// different remedies, so they never collapse into an empty list.
    func testARejectedCredentialAndAnUnreachableServerStaySeparate() async throws {
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let model = makeModel()
        model.observe(session)

        sender.devicesError = InboxError.api(status: 401, code: "")
        model.refreshTargets(token: "bearer")
        await waitUntil("the unauthorized answer") { model.directory != .loading }
        XCTAssertEqual(model.directory, .unavailable(.notAuthorized))

        sender.devicesError = InboxError.network
        model.refreshTargets(token: "bearer")
        await waitUntil("the unreachable answer") { model.directory != .loading }
        XCTAssertEqual(model.directory, .unavailable(.unreachable))

        // An empty bearer never leaves this device, and it is reported as the
        // account problem it is rather than as a network failure.
        model.refreshTargets(token: "")
        XCTAssertEqual(model.directory, .unavailable(.notAuthorized))
        XCTAssertEqual(model.candidates, [], "no list may be claimed from a refused read")
    }

    /// A blocked device can never become the selection, and one that becomes
    /// blocked stops being it.
    ///
    /// A selection the Send button then refuses is a dead end the user has to
    /// discover by pressing it.
    func testABlockedDeviceCanNeitherBeChosenNorRemainChosen() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        XCTAssertEqual(model.selectedTargetID, deviceID)

        // Receiving is switched off over there, and the list is re-read.
        sender.deviceRows = [row(autoAccept: .off), currentRow()]
        model.refreshTargets(token: "bearer")
        await waitUntil("the second read") { model.candidates.first?.isSendable == false }
        XCTAssertNil(model.selectedTargetID,
                     "a device that stopped being sendable must stop being the target")

        model.selectTarget(deviceID)
        XCTAssertNil(model.selectedTargetID, "a blocked row must not become the selection")
    }

    // MARK: - one send, all the way to a task

    /// The happy path, and the four claims it is allowed to make in order.
    func testASendBecomesADurableJobAndThenExactlyOneTrackedTask() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        var committed: [(String, String?)] = []
        model.onSelectionCommitted = { committed.append(($0, $1)) }

        // Scripted BEFORE the send, because the send is faster than this test:
        // the fake answers an unscripted create with a network error, which the
        // coordinator correctly treats as ambiguous and retries.
        sender.createOutcomes = [
            .success(InboxTaskCreation(task: task(idempotencyKey: "recorded"), created: true)),
        ]
        sender.taskResults = [.success(task(state: .saved, idempotencyKey: "recorded"))]

        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("the arrival") { model.items.first?.activity.isSavedOnTarget == true }

        XCTAssertEqual(transport.purposes, [.deviceTask],
                       "the ciphertext must be uploaded under the delivery purpose")
        XCTAssertEqual(sender.creates.count, 1, "exactly one delivery per send")
        let sent = try XCTUnwrap(sender.createdIdempotencyKeys.first)
        XCTAssertTrue(InboxIdempotencyKey.isValid(sent),
                      "the create must carry a key central will accept")

        // The commit was announced once, the moment the plan and its content key
        // became durable — before the upload, let alone before any task existed.
        XCTAssertEqual(committed.count, 1)
        XCTAssertEqual(committed.first?.0, "acct-1")
        XCTAssertNil(committed.first?.1)

        XCTAssertEqual(model.items.count, 1)
        XCTAssertEqual(model.items.first?.taskID, taskID)
        XCTAssertFalse(model.items.first?.isRecoverable ?? true,
                       "a delivered job's plan is released, so Retry may not be offered")
        XCTAssertEqual(InboxSendActions.offered(for: try XCTUnwrap(model.items.first)), [.dismiss])
        XCTAssertEqual(store.deviceSendPlans(for: "acct-1"), [],
                       "the staged plaintext must not outlive a delivered send")
    }

    /// What the durable plan actually says, read while it is still on disk.
    ///
    /// Driven through the one definitive refusal that releases NOTHING — a
    /// rejected credential — so every field is inspectable after the attempt
    /// has finished, and the "unauthorized keeps everything" rule is asserted at
    /// this layer rather than assumed from the coordinator's.
    func testTheDurablePlanIsADeviceTaskCarryingTheExactRequestIdentity() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        sender.createOutcomes = [.failure(InboxError.api(status: 401, code: ""))]

        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("the rejected credential") {
            model.items.first?.activity == .stopped(.notAuthorized)
        }

        let minted = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
        XCTAssertEqual(minted.effectivePurpose, .deviceTask,
                       "a delivery must never be staged as a public share")
        XCTAssertEqual(minted.ttl, UploadPurpose.deviceTaskTTLSeconds,
                       "the PRD fixes a delivery's TTL at 24 hours")
        XCTAssertFalse(minted.burnAfterRead, "a delivery may never burn after read")
        XCTAssertEqual(minted.targetDeviceId, deviceID)
        XCTAssertEqual(minted.targetKeyId, keyID)
        XCTAssertEqual(minted.targetKeyGeneration, 4)
        XCTAssertEqual(minted.createIdempotencyKey, sender.createdIdempotencyKeys.first,
                       "the key on the wire is the one persisted before any network work")
        XCTAssertNotNil(minted.targetWrappedKey,
                        "the randomized sealed box must be durable before the create")
        XCTAssertNil(minted.deviceTaskId, "no task was created")
        XCTAssertEqual(objects.deleted, [],
                       "a rejected credential is self-healing and releases nothing")
        let key = try await keys.key(for: minted.jobId)
        XCTAssertNotNil(key)
        XCTAssertEqual(InboxSendActions.offered(for: try XCTUnwrap(model.items.first)),
                       [.retry, .discard])
    }

    /// **An upload is not a delivery.** No local phase may reach `saved`.
    func testNoLocalPhaseIsEverRenderedAsAnArrival() {
        let local: [InboxSendActivity] = [
            .staged, .preparing, .uploading(sent: 10, total: 10), .creating, .unknown,
            .stopped(.uploadFailed), .stopped(.unknownOutcome),
        ]
        for activity in local {
            XCTAssertFalse(activity.isSavedOnTarget, "\(activity) claims an arrival")
        }
        for state in InboxTaskState.allCases {
            XCTAssertEqual(InboxSendActivity.tracking(state).isSavedOnTarget, state == .saved,
                           "only central's own saved may be an arrival")
        }
    }

    func testALostContentKeyOffersDiscardButNeverAnImpossibleRetry() {
        let item = InboxSendItem(
            id: "job", fileCount: 1, byteCount: 18,
            targetDeviceID: "target", targetName: "Mac",
            activity: .stopped(.contentKeyMissing), taskID: nil,
            savedAt: 0, expiresAt: 0, isRecoverable: true)

        XCTAssertEqual(InboxSendActions.offered(for: item), [.discard],
                       "a missing content key cannot be reconstructed by retrying")
    }

    // MARK: - the draft, and when it may be retired

    /// The draft is retired only once the durable job owns its bytes.
    func testTheDraftIsRetiredExactlyWhenTheJobBecomesDurable() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUploadModel()
        let selectionModel = makeSelectionModel(upload: upload, session: session)
        await upload.recoveryTask?.value
        selectionModel.refreshSharedDrafts()
        await waitUntil("the waiting draft") { !selectionModel.sharedDrafts.isEmpty }
        selectionModel.useSharedDraft(plan.id)
        XCTAssertEqual(selectionModel.adoptedDraft?.id, plan.id)

        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        model.onSelectionCommitted = { [weak selectionModel] account, draft in
            selectionModel?.deviceSendCommitted(accountId: account, sourceDraftId: draft)
        }

        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id],
                       "adoption alone must never remove the user's only copy")

        model.send(files: selectionModel.selectedFiles, sourceDraftId: plan.id, token: "bearer")
        // Preparing the plan is the durable-ownership boundary, but the model
        // publishes it and invokes the selection callback immediately after the
        // write. Waiting for the write alone races those two synchronous steps
        // under a loaded runner and then tests an intermediate state the API
        // never promises to expose as completion.
        await waitUntil("the durable ownership handoff") {
            !self.store.deviceSendPlans(for: "acct-1").isEmpty
                && self.drafts.drafts().isEmpty
                && selectionModel.adoptedDraft == nil
                && upload.state == .idle
        }

        let minted = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
        XCTAssertEqual(minted.sourceDraftId, plan.id,
                       "the durable job must record where its bytes came from")
        XCTAssertEqual(drafts.drafts(), [],
                       "the draft is retired once, and only once a durable job owns it")
        XCTAssertNil(selectionModel.adoptedDraft)
        XCTAssertEqual(upload.state, .idle,
                       "the selection describes bytes a durable job has taken over")
    }

    /// **Adversarial: nothing is retired before durable ownership.**
    ///
    /// The content key cannot be filed, so no target could ever open what was
    /// staged. The job is destroyed — and the draft, which in exactly this
    /// failure is the user's only other copy, is not.
    func testAKeyStorageFailureRetiresNoDraftAndLeavesNoJob() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUploadModel()
        let selectionModel = makeSelectionModel(upload: upload, session: session)
        await upload.recoveryTask?.value
        selectionModel.refreshSharedDrafts()
        await waitUntil("the waiting draft") { !selectionModel.sharedDrafts.isEmpty }
        selectionModel.useSharedDraft(plan.id)

        let (model, _) = await signedIn(pendingKeys: UnsavableKeyStore())
        model.selectTarget(deviceID)
        var committed = 0
        model.onSelectionCommitted = { _, _ in committed += 1 }

        model.send(files: selectionModel.selectedFiles, sourceDraftId: plan.id, token: "bearer")
        await waitUntil("the refusal") { model.refusal != nil }

        XCTAssertEqual(model.refusal, .keyStorageFailed)
        XCTAssertEqual(committed, 0, "nothing may be announced as durable")
        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id],
                       "the user's only other copy must survive a failed send")
        XCTAssertEqual(store.deviceSendPlans(for: "acct-1"), [],
                       "a job whose key could not be filed must not be left pretending")
        XCTAssertEqual(sender.creates, [], "nothing may leave this device")
        XCTAssertEqual(model.items, [], "and the placeholder card goes with it")
    }

    /// **Adversarial: a failed cleanup is reported, and does not resurrect the
    /// draft as a second send.**
    ///
    /// `SharedDraftStore.retire` writes its tombstone before it removes bytes,
    /// so a removal that fails leaves a copy taking up space rather than a draft
    /// that comes back around. What the user is owed is being told.
    func testAFailedDraftRemovalIsReportedAndNeverOffersTheFilesAgain() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUploadModel()
        let selectionModel = makeSelectionModel(upload: upload, session: session)
        await upload.recoveryTask?.value
        selectionModel.refreshSharedDrafts()
        await waitUntil("the waiting draft") { !selectionModel.sharedDrafts.isEmpty }
        selectionModel.useSharedDraft(plan.id)

        // The physical removal fails and the logical one does not, which is the
        // exact split `SharedDraftStore.retire` is built around: the draft's own
        // directory is made unwritable, so `removeItem` cannot delete what is
        // inside it, while the tombstone beside it is still written.
        let draftDirectory = drafts.draftURL(id: plan.id)
        try FileManager.default.setAttributes([.posixPermissions: 0o555],
                                              ofItemAtPath: draftDirectory.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755],
                                                   ofItemAtPath: draftDirectory.path)
        }

        selectionModel.deviceSendCommitted(accountId: "acct-1", sourceDraftId: plan.id)

        XCTAssertEqual(selectionModel.selectionError, L10n.t(.uploadCleanupFailed),
                       "a cleanup this device could not finish must be said out loud")
        XCTAssertNil(selectionModel.adoptedDraft,
                     "the durable job owns those bytes whether or not the copy could be removed")
        await waitUntil("the re-read inbox") { selectionModel.sharedDrafts.isEmpty }
        XCTAssertEqual(selectionModel.sharedDrafts, [],
                       "a draft a durable job has taken over may never be offered again")
    }

    /// A report from an account that has since left retires nothing.
    func testACommitReportForAnotherAccountRetiresNothing() async throws {
        let plan = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready("acct-1"))
        let upload = makeUploadModel()
        let selectionModel = makeSelectionModel(upload: upload, session: session)
        await upload.recoveryTask?.value
        selectionModel.refreshSharedDrafts()
        await waitUntil("the waiting draft") { !selectionModel.sharedDrafts.isEmpty }

        selectionModel.deviceSendCommitted(accountId: "acct-2", sourceDraftId: plan.id)

        XCTAssertEqual(drafts.drafts().map(\.id), [plan.id],
                       "a job belonging to another account may not delete this one's files")
        XCTAssertNil(selectionModel.selectionError)
    }

    // MARK: - adversarial: the account leaves

    /// **Adversarial: an account switch during a send.**
    ///
    /// The work stops and the screen stops describing it SYNCHRONOUSLY — a
    /// delivery on screen for one runloop turn is a delivery the next account
    /// can see. And nothing durable is destroyed: the plan carries the
    /// idempotency key that is the only thing able to converge an ambiguous
    /// create, and it stays on disk scoped to the account that made it.
    func testAnAccountSwitchStopsAndHidesTheWorkWithoutDestroyingIt() async throws {
        let (model, session) = await signedIn("acct-1")
        model.selectTarget(deviceID)
        model.send(files: try selection(), sourceDraftId: nil, token: "bearer-1")
        await waitUntil("a durable plan") { model.items.first?.isRecoverable == true }
        let minted = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)

        session.send(ready("acct-2"))

        // Synchronously, with no await in between.
        XCTAssertEqual(model.items, [], "the previous account's delivery is still on screen")
        XCTAssertEqual(model.candidates, [])
        XCTAssertNil(model.selectedTargetID)
        XCTAssertEqual(model.directory, .idle)

        XCTAssertEqual(store.deviceSendPlans(for: "acct-1").map(\.jobId), [minted.jobId],
                       "leaving an account must not destroy the key that converges its retry")
        XCTAssertEqual(store.deviceSendPlans(for: "acct-2"), [],
                       "and the next account may not see it")
        let key = try await keys.key(for: minted.jobId)
        XCTAssertNotNil(key, "the content key belongs to the plan, not to the session")
    }

    /// A sign-out is the same rule, and the outstanding list empties with it.
    func testASignOutStopsDescribingTheAccountsDeliveries() async throws {
        // Hold the coordinator on the protected-store read. This is the exact
        // suspension at which the hosted runner exposed the race: sign-out
        // cancels the owner, then the read returns and the old task must not use
        // its old bearer for even one device or create request.
        let pendingKeys = SuspendingReadKeyStore()
        let (model, session) = await signedIn("acct-1", pendingKeys: pendingKeys)
        model.selectTarget(deviceID)
        model.send(files: try selection(), sourceDraftId: nil, token: "bearer-1")
        await waitUntil("the suspended protected-store read") {
            model.items.first?.isRecoverable == true && pendingKeys.readStarted
        }

        session.send(.loggedOut)
        XCTAssertEqual(model.items, [])
        XCTAssertEqual(model.candidates, [])
        XCTAssertEqual(store.deviceSendPlans(for: "acct-1").count, 1,
                       "signing out is not a reason to delete the user's staged files")

        let afterSignOut = sender.calls.count
        pendingKeys.releaseRead()
        await waitUntil("the cancelled read returning") { pendingKeys.readReturned }
        // Let the cancelled continuation reach the coordinator and the model's
        // cancellation handler. No network fake has a suspension of its own, so
        // any stale request would be recorded before this yield completes.
        await Task.yield()

        // Signing back in OFFERS the plan again, from disk, with no network.
        session.send(ready("acct-1"))
        await waitUntil("the recovered offer") { !model.items.isEmpty }
        XCTAssertEqual(model.items.count, 1)
        XCTAssertTrue(model.items.first?.isRecoverable ?? false)
        XCTAssertEqual(model.items.first?.activity, .staged,
                       "a recovered plan has delivered nothing and must not claim to have")
        // A recovered card offers Send, which is a first send of files chosen in
        // a session the user does not remember. It must say which files.
        XCTAssertEqual(model.items.first?.files, [FileMeta(name: "a.txt", size: 18)],
                       "a recovered delivery must name what it holds before offering Send")
        XCTAssertNil(model.items.first?.targetName,
                     "a recovered plan records the device id, and a name is central's to change")
        XCTAssertEqual(sender.calls.count, afterSignOut,
                       "a cancelled old-account task or recovery touched the network")
    }

    // MARK: - adversarial: relaunch, ambiguity, staleness, cancellation

    /// **Adversarial: an ambiguous create, then a relaunch.**
    ///
    /// The first attempt's answer is lost, so nothing is released and the card
    /// says so. A second model over the same store — which is what a relaunch
    /// IS — recovers the plan, retries under the SAME idempotency key, and
    /// converges on one task instead of queueing a second delivery.
    func testAnAmbiguousCreateSurvivesRelaunchAndConvergesOnOneTask() async throws {
        let (first, _) = await signedIn()
        first.selectTarget(deviceID)
        sender.createOutcomes = [.failure(InboxError.network)]
        sender.tasksError = InboxError.network

        first.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("the ambiguous outcome") {
            if case .stopped(.unknownOutcome) = first.items.first?.activity { return true }
            return false
        }
        let held = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
        let idempotency = try XCTUnwrap(held.createIdempotencyKey)
        XCTAssertNotNil(held.targetWrappedKey,
                        "the randomized sealed box must be durable before any create")
        XCTAssertEqual(objects.deleted, [], "an ambiguous outcome releases nothing")
        let item = try XCTUnwrap(first.items.first)
        XCTAssertEqual(InboxSendActions.offered(for: item), [.retry, .discard])
        XCTAssertTrue(InboxSendActions.warnsDeliveryMayStillArrive(.discard, for: item),
                      "discarding an unknown outcome has to warn that it may still arrive")

        // The relaunch: a brand-new model over the same durable state.
        let second = makeModel()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        second.observe(session)
        await waitUntil("the recovered plan") { !second.items.isEmpty }
        XCTAssertEqual(second.items.first?.id, held.jobId)
        XCTAssertEqual(second.items.first?.activity, .staged)

        sender.tasksError = nil
        sender.createOutcomes = [
            .success(InboxTaskCreation(task: task(idempotencyKey: idempotency), created: true)),
        ]
        sender.taskResults = [.success(task(state: .queued, idempotencyKey: idempotency))]
        second.act(.retry, on: held.jobId, token: "bearer")
        await waitUntil("the converged task") { second.items.first?.taskID != nil }

        // Four creates: the first attempt spends its whole ambiguous budget
        // before asking central what exists, and the retry adds one. What
        // matters is not how many, but that every one of them is the SAME
        // request — a fresh key or a fresh box would be a second delivery of
        // bytes the user asked to send once.
        XCTAssertEqual(sender.createdIdempotencyKeys.count,
                       InboxSendCoordinator.ambiguousCreateAttempts + 1)
        XCTAssertEqual(Set(sender.createdIdempotencyKeys), [idempotency],
                       "a retry must carry the key the first attempt minted")
        XCTAssertEqual(Set(sender.createdWrappedKeys).count, 1,
                       "and the exact randomized box, or central sees a different request")
        XCTAssertEqual(transport.initCount, 1,
                       "the ciphertext is already up; a retry must not send it again")
        XCTAssertEqual(second.items.first?.taskID, taskID)
    }

    /// **Adversarial: the target stops being a legal destination.**
    ///
    /// The picker's own list can be minutes old, so the authority is central,
    /// asked before a byte of ciphertext moves. The refusal keeps its own name
    /// all the way to the card, no encrypted upload is spent on it, and — the
    /// part that costs the user their files if it is wrong — the staged copy
    /// survives, so the remedy the sentence names ("switch it on there first")
    /// leads to a Retry that has something to retry.
    func testATargetThatTurnedReceivingOffIsRefusedByNameWithoutSpendingAnUpload() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        // Receiving is switched off over there between the list and the tap.
        sender.deviceRows = [row(autoAccept: .off), currentRow()]

        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("the named refusal") {
            model.items.first?.activity == .stopped(.targetUnavailable(.receiveOff))
        }

        XCTAssertEqual(transport.initCount, 0,
                       "eligibility is checked first, so a refusal costs no encrypted transfer")
        XCTAssertEqual(sender.creates, [])
        let held = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.jobURL(for: held.jobId).path),
                      "a retryable refusal must not delete the user's staged files")
        let key = try await keys.key(for: held.jobId)
        XCTAssertNotNil(key)
        XCTAssertEqual(InboxSendActions.offered(for: try XCTUnwrap(model.items.first)),
                       [.retry, .discard])
        XCTAssertEqual(InboxSendPresentation.status(for: .stopped(.targetUnavailable(.receiveOff))),
                       L10n.t(.sendBlockReceiveOff))
    }

    /// **Adversarial: the refusal lands after the draft has already been
    /// retired — and the user's files still exist.**
    ///
    /// This is the composition of two safe-looking steps that used to lose data.
    /// The Share Extension's copy is retired the moment the durable job owns the
    /// bytes, which is correct; the job was then purged by a definitive
    /// pre-upload refusal, which is also defensible on its own. Together they
    /// deleted the last copy Relayium held, under a message inviting a retry.
    func testARefusedTargetLeavesTheFilesTheRetiredDraftHandedOver() async throws {
        let draft = try stageDraft()
        let session = CurrentValueSubject<SessionState, Never>(ready())
        let upload = makeUploadModel()
        let selectionModel = makeSelectionModel(upload: upload, session: session)
        await upload.recoveryTask?.value
        selectionModel.refreshSharedDrafts()
        await waitUntil("the waiting draft") { !selectionModel.sharedDrafts.isEmpty }
        selectionModel.useSharedDraft(draft.id)

        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        model.onSelectionCommitted = { [weak selectionModel] account, source in
            selectionModel?.deviceSendCommitted(accountId: account, sourceDraftId: source)
        }
        // The device leaves the account between the list and the tap.
        sender.deviceRows = [currentRow()]

        model.send(files: selectionModel.selectedFiles, sourceDraftId: draft.id, token: "bearer")
        await waitUntil("the definitive refusal") {
            model.items.first?.activity == .stopped(.targetMissing)
        }

        XCTAssertEqual(drafts.drafts(), [],
                       "the draft was correctly retired when the durable job took over")
        let held = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first,
                                 "the retired draft's bytes must still exist somewhere")
        XCTAssertEqual(held.sourceDraftId, draft.id)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.jobURL(for: held.jobId).path))
        XCTAssertEqual(InboxSendActions.offered(for: try XCTUnwrap(model.items.first)),
                       [.retry, .discard],
                       "and the user must be able to send them somewhere else")
    }

    /// A device this build cannot drive keeps its own name all the way to the UI.
    func testAnUnsupportedTargetKeepsItsOwnReason() async throws {
        sender.deviceRows = [row(capability: "receive/9"), currentRow()]
        let (model, _) = await signedIn()
        let candidate = try XCTUnwrap(model.candidates.first)
        XCTAssertEqual(candidate.availability.block, .unsupportedCapability)
        XCTAssertEqual(InboxSendPresentation.text(for: InboxTargetBlock.unsupportedCapability),
                       L10n.t(.sendBlockUnsupportedCapability))
        XCTAssertNotEqual(InboxSendPresentation.text(for: InboxTargetBlock.unsupportedCapability),
                          InboxSendPresentation.text(for: InboxTargetBlock.cannotReceive),
                          "two remedies in two places may not share one sentence")
    }

    /// **Adversarial: the user stops an attempt.**
    ///
    /// Everything durable survives — the plan, the staged bytes, the content key
    /// and the idempotency key — so the honest state is the one a recovered plan
    /// is in, and both recoveries stay available.
    func testStoppingAnAttemptKeepsEverythingDurableAndOffersBothRecoveries() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        sender.createOutcomes = [.failure(InboxError.network)]
        sender.tasksError = InboxError.network
        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("a durable plan") { model.items.first?.isRecoverable == true }
        let job = try XCTUnwrap(model.items.first?.id)

        await waitUntil("the attempt to stop running") {
            !(model.items.first?.activity.isRunning ?? true)
        }
        model.act(.stopAttempt, on: job, token: "bearer")

        let held = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
        XCTAssertEqual(held.jobId, job)
        XCTAssertNotNil(held.createIdempotencyKey)
        let retained = try await keys.key(for: job)
        XCTAssertNotNil(retained)
        XCTAssertEqual(objects.deleted, [])
        XCTAssertEqual(InboxSendActions.offered(for: try XCTUnwrap(model.items.first)),
                       [.retry, .discard])
    }

    /// **Adversarial: central refuses a cancel.**
    ///
    /// A refused cancel means a live delivery, so the card stays and the refusal
    /// is reported on it. Removing it would leave the user with a file arriving
    /// that nothing here can name or stop.
    func testARefusedCancelKeepsTheCardAndSaysWhy() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        sender.createOutcomes = [
            .success(InboxTaskCreation(task: task(idempotencyKey: "recorded"), created: true)),
        ]
        sender.taskResults = [.success(task(state: .queued, idempotencyKey: "recorded"))]
        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("the tracked task") { model.items.first?.taskID != nil }
        let job = try XCTUnwrap(model.items.first?.id)

        sender.cancelError = InboxError.api(status: 409, code: InboxRejection.staleClaim.rawValue)
        model.act(.cancelDelivery, on: job, token: "bearer")
        await waitUntil("the refusal") { model.actionError != nil }

        XCTAssertEqual(model.actionError, .cancelRefused(itemID: job))
        XCTAssertEqual(model.items.map(\.id), [job],
                       "a delivery central would not cancel must stay on screen")
        XCTAssertEqual(InboxSendPresentation.text(for: .cancelRefused(itemID: job)),
                       L10n.t(.sendCancelRefused))
    }

    /// A cancel central accepts removes the card, and only then.
    func testAnAcceptedCancelRemovesTheDelivery() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        sender.createOutcomes = [
            .success(InboxTaskCreation(task: task(idempotencyKey: "recorded"), created: true)),
        ]
        sender.taskResults = [.success(task(state: .queued, idempotencyKey: "recorded"))]
        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("the tracked task") { model.items.first?.taskID != nil }
        let job = try XCTUnwrap(model.items.first?.id)

        model.act(.cancelDelivery, on: job, token: "bearer")
        await waitUntil("the removal") { model.items.isEmpty }
        XCTAssertNil(model.actionError)
        XCTAssertEqual(sender.calls.filter { if case .cancel = $0 { return true }; return false }
                        .count, 1)
    }

    /// Actions that spend a credential refuse an empty one rather than issuing a
    /// request with no bearer.
    func testAnEmptyCredentialRefusesEveryActionThatWouldSpendOne() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("a durable plan") { model.items.first?.isRecoverable == true }
        await waitUntil("the attempt to settle") {
            !(model.items.first?.activity.isRunning ?? true)
        }
        let job = try XCTUnwrap(model.items.first?.id)
        let before = sender.calls.count

        for action in [InboxSendAction.retry, .discard] {
            model.act(action, on: job, token: "")
            XCTAssertEqual(model.refusal, .notSignedIn, "\(action) accepted an empty credential")
        }
        XCTAssertEqual(sender.calls.count, before, "no request may leave with an empty bearer")

        model.send(files: try selection(), sourceDraftId: nil, token: "")
        XCTAssertEqual(model.refusal, .notSignedIn)
    }

    /// Nothing is selected, or no device is: two different refusals, because the
    /// remedies are two different controls.
    func testTheTwoPreconditionsForASendKeepTheirOwnRefusals() async throws {
        let (model, _) = await signedIn()
        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        XCTAssertEqual(model.refusal, .noTargetChosen)

        model.selectTarget(deviceID)
        model.send(files: [], sourceDraftId: nil, token: "bearer")
        XCTAssertEqual(model.refusal, .noSelection)
        XCTAssertEqual(store.deviceSendPlans(for: "acct-1"), [])
    }

    // MARK: - sending a message

    /// A message goes through the same durable machinery a file does, and comes
    /// out the other end as a delivery whose sealed manifest says `text`.
    func testAMessageBecomesATextDeliveryOnTheSameDurablePath() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        sender.createOutcomes = [
            .success(InboxTaskCreation(task: task(idempotencyKey: "recorded"), created: true)),
        ]
        sender.taskResults = [.success(task(state: .saved, idempotencyKey: "recorded"))]

        model.sendText("meet me at 6", token: "bearer")
        await waitUntil("the arrival") { model.items.first?.activity.isSavedOnTarget == true }

        XCTAssertEqual(transport.purposes, [.deviceTask])
        XCTAssertEqual(sender.creates.count, 1, "exactly one delivery per message")
        XCTAssertTrue(InboxIdempotencyKey.isValid(try XCTUnwrap(sender.createdIdempotencyKeys.first)))
        // The card describes a message by its size and nothing else: the staged
        // slot label is internal and must never be rendered as a file name.
        XCTAssertEqual(model.items.first?.files, [])
        XCTAssertEqual(model.items.first?.byteCount, Array("meet me at 6".utf8).count)
    }

    /// The plan the retry would rebuild from says `text`, so no later attempt
    /// can seal a file manifest over a message.
    func testTheDurablePlanRecordsTheMessageKind() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        sender.createOutcomes = [.failure(InboxError.api(status: 401, code: ""))]

        model.sendText("still here", token: "bearer")
        await waitUntil("the rejected credential") {
            model.items.first?.activity == .stopped(.notAuthorized)
        }

        let minted = try XCTUnwrap(store.deviceSendPlans(for: "acct-1").first)
        XCTAssertEqual(minted.effectiveDeliveryKind, .text)
        XCTAssertEqual(minted.effectivePurpose, .deviceTask)
        XCTAssertEqual(try InboxSendManifest.manifest(for: minted).kind, .text)
    }

    /// A device that does not announce `inbox.text.v1` is refused BEFORE
    /// anything is staged: it would land the message as a file in somebody's
    /// downloads folder, which is not what the sender was promised.
    func testAMessageIsRefusedForADeviceThatWouldNotPresentIt() async throws {
        sender.deviceRows = [row(presentsText: false), currentRow()]
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)

        model.sendText("hello", token: "bearer")

        XCTAssertEqual(model.refusal, .textUnsupported)
        XCTAssertEqual(store.deviceSendPlans(for: "acct-1"), [])
        XCTAssertTrue(transport.purposes.isEmpty)
    }

    /// And the same device still takes FILES. Requiring the text token of a file
    /// send would refuse every receiver that has no message surface.
    func testTheSameDeviceStillTakesFilesWithoutTheTextCapability() async throws {
        sender.deviceRows = [row(presentsText: false), currentRow()]
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        sender.createOutcomes = [
            .success(InboxTaskCreation(task: task(idempotencyKey: "recorded"), created: true)),
        ]

        model.send(files: try selection(), sourceDraftId: nil, token: "bearer")
        await waitUntil("the tracked task") { model.items.first?.taskID != nil }

        XCTAssertNil(model.refusal)
        XCTAssertEqual(transport.purposes, [.deviceTask])
    }

    /// Both message bounds, measured in UTF-8 bytes, refused before staging.
    func testAMessageOutsideItsBoundsIsRefusedWithItsOwnReason() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)

        model.sendText("", token: "bearer")
        XCTAssertEqual(model.refusal, .messageEmpty)

        model.sendText(String(repeating: "a", count: InboxManifest.maxTextBytes + 1),
                       token: "bearer")
        XCTAssertEqual(model.refusal, .messageTooLong)

        // One emoji is four UTF-8 bytes, so a per-character bound would let a
        // message past a check the seal then refuses.
        model.sendText(String(repeating: "🙂", count: InboxManifest.maxTextBytes / 4 + 1),
                       token: "bearer")
        XCTAssertEqual(model.refusal, .messageTooLong)

        XCTAssertEqual(store.deviceSendPlans(for: "acct-1"), [])
        XCTAssertTrue(transport.purposes.isEmpty)
    }

    /// The preconditions a message shares with a file send keep their own
    /// refusals, and the message-specific ones do not shadow them.
    func testAMessageKeepsTheSharedPreconditions() async throws {
        let (model, _) = await signedIn()
        model.sendText("hello", token: "bearer")
        XCTAssertEqual(model.refusal, .noTargetChosen)

        model.selectTarget(deviceID)
        model.sendText("hello", token: "")
        XCTAssertEqual(model.refusal, .notSignedIn)
    }

    /// Each new refusal renders a sentence, and none of them renders the raw
    /// enum name at the user.
    func testTheMessageRefusalsAllRenderCopy() {
        for refusal in [InboxSendRefusal.messageEmpty, .messageTooLong, .textUnsupported] {
            let text = InboxSendPresentation.text(for: refusal)
            XCTAssertFalse(text.isEmpty)
            XCTAssertFalse(text.contains("refusal"), "a raw key reached the user: \(text)")
        }
        XCTAssertNotEqual(InboxSendPresentation.text(for: InboxSendRefusal.messageEmpty),
                          InboxSendPresentation.text(for: InboxSendRefusal.messageTooLong))
    }

    // MARK: - helpers that need the shared-draft half

    private func stageDraft(named: String = "shared.txt") throws -> SharedDraftPlan {
        let source = root.appendingPathComponent("source-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try Data("shared".utf8).write(to: source.appendingPathComponent(named))
        let writer = try drafts.beginDraft()
        try writer.adopt(source.appendingPathComponent(named), suggestedName: named)
        return try writer.publish()
    }

    private func makeUploadModel() -> CloudUploadModel {
        let model = CloudUploadModel(
            uploader: CloudUploader(transport: StubTransport()),
            keyStore: InMemoryStoredLinkKeyStore(),
            origin: "https://relayium.com",
            pending: PendingUploadSupport(store: store, keys: keys, drafts: drafts))
        model.accountId = "acct-1"
        return model
    }

    private func makeSelectionModel(upload: CloudUploadModel,
                                    session: CurrentValueSubject<SessionState, Never>)
        -> SendSelectionModel {
        let model = SendSelectionModel(
            upload: upload,
            photos: PhotoStagingArea(root: root.appendingPathComponent("photos")),
            inbox: root.appendingPathComponent("inbox"),
            drafts: drafts,
            fetchConfig: { ServerConfig(maxFileSize: 0) })
        model.observe(session)
        return model
    }

    /// A pending-key store that cannot save. The failure this exists for is the
    /// one where the draft MUST survive: without a key, nothing could ever open
    /// what was staged.
    private final class UnsavableKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        func save(id: String, keyB64url: String) async throws { throw KeychainError.status(-25308) }
        func key(for id: String) async throws -> String? { nil }
        func remove(id: String) async throws {}
    }

    /// Saves normally, then suspends the first read until the test releases it.
    /// It deliberately ignores task cancellation while suspended: the system
    /// keychain API may return after its caller was cancelled, so the
    /// coordinator — not a friendly test double — owns the post-await check.
    private final class SuspendingReadKeyStore: StoredLinkKeyStore, @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: String] = [:]
        private var waiter: CheckedContinuation<Void, Never>?
        private var released = false
        private var _readStarted = false
        private var _readReturned = false

        var readStarted: Bool { sync { _readStarted } }
        var readReturned: Bool { sync { _readReturned } }

        func save(id: String, keyB64url: String) async throws {
            sync { values[id] = keyB64url }
        }

        func key(for id: String) async throws -> String? {
            let value = sync { () -> String? in
                _readStarted = true
                return values[id]
            }
            await withCheckedContinuation { continuation in
                let resumeNow = sync { () -> Bool in
                    if released { return true }
                    waiter = continuation
                    return false
                }
                if resumeNow { continuation.resume() }
            }
            sync { _readReturned = true }
            return value
        }

        func remove(id: String) async throws { sync { values.removeValue(forKey: id) } }

        func releaseRead() {
            let continuation = sync { () -> CheckedContinuation<Void, Never>? in
                released = true
                defer { waiter = nil }
                return waiter
            }
            continuation?.resume()
        }

        @discardableResult
        private func sync<T>(_ body: () -> T) -> T {
            lock.lock(); defer { lock.unlock() }
            return body()
        }
    }
}
