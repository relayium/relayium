import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

private final class NoopUploadTransport: ResumableTransport, @unchecked Sendable {
    func initUpload(header: [UInt8], purpose: UploadPurpose, burnAfterRead: Bool, ttl: Int,
                    size: Int, token: String) async throws -> (uploadId: String, chunkSize: Int) {
        ("u", 1 << 20)
    }
    func patchChunk(uploadId: String, bytes: Data, from: Int, to: Int,
                    total: Int, token: String,
                    onBytesSent: ((Int) -> Void)?) async throws -> PatchOutcome { .committed(received: to) }
    func uploadOffset(uploadId: String, token: String) async throws -> Int { 0 }
    func finalizeUpload(uploadId: String, token: String) async throws -> UploadResult {
        UploadResult(id: "u", expiresAt: 0)
    }
}

/// A32 (macOS): shared drafts — and every other batch the OS hands this app —
/// are adopted automatically, stay removable, are never sent, and never
/// overwrite a selection or a result the user already has.
///
/// Each test drives the SAME objects the Stored Send pane wires together —
/// `AppFileOpenCoordinator`, `SelectionStore`, `CloudUploadModel` — in the order
/// the pane does: adopt with `batch(for:busy:)`, `selection.add`, push with
/// `model.pick`. `MacSurfaceGuardTests` holds the pane to that wiring.
@MainActor
final class MacSharedDraftAdoptionTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("a32-mac-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    private func file(_ relative: String) throws -> URL {
        let url = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data([1]).write(to: url)
        return url
    }

    private func makeModel() -> CloudUploadModel {
        CloudUploadModel(uploader: CloudUploader(transport: NoopUploadTransport()),
                         keyStore: InMemoryStoredLinkKeyStore(),
                         origin: "https://relayium.com")
    }

    /// The pane's adoption turn, step for step.
    @discardableResult
    private func paneAdopts(_ coordinator: AppFileOpenCoordinator, into store: SelectionStore,
                            model: CloudUploadModel) -> Bool {
        guard let batch = coordinator.batch(for: .storedSend, busy: !model.acceptsOpenedFiles)
        else { return false }
        store.add(batch.urls)
        coordinator.consume(batch)
        if let expanded = store.selection { model.pick(expanded) }
        return true
    }

    /// The pane's push on a user pick or drop.
    private func paneAdds(_ urls: [URL], into store: SelectionStore, model: CloudUploadModel) {
        store.add(urls)
        if let expanded = store.selection { model.pick(expanded) } else { model.clearSelection() }
    }

    // ── M1: a result is never replaced ─────────────────────────────────────

    /// **A draft arriving on the link-ready card waits; it does not replace the
    /// link.** Before A32 the pane asked only `isBusy`, which is false in
    /// `.done`, so the batch was staged, `pick` ran, and the link — the only
    /// on-screen copy of its key — was gone.
    func testADraftArrivingOnAFinishedLinkWaitsForSendAnother() async throws {
        let model = makeModel()
        let store = SelectionStore()
        paneAdds([try file("sent.txt")], into: store, model: model)
        await model.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        guard case let .done(link, _, _) = model.state else { return XCTFail("no result") }

        let coordinator = AppFileOpenCoordinator(navigation: AppNavigationModel(selection: .storedSend))
        let draft = try file("draft.txt")
        coordinator.deliver([draft])
        XCTAssertFalse(model.acceptsOpenedFiles, "a finished link accepted opened files")
        XCTAssertFalse(paneAdopts(coordinator, into: store, model: model),
                       "the pane adopted a batch over a finished link")
        guard case .done(link, _, _) = model.state else {
            return XCTFail("the finished link was replaced by an arriving draft: \(model.state)")
        }
        XCTAssertEqual(coordinator.staged?.urls, [draft], "the waiting batch was dropped")

        // "Send another" is what makes room for it — and the draft is then adopted.
        model.reset()
        XCTAssertTrue(model.acceptsOpenedFiles)
        XCTAssertTrue(paneAdopts(coordinator, into: store, model: model))
        XCTAssertNil(coordinator.staged)
        XCTAssertTrue(model.selectedFiles.map(\.url).contains(draft.standardizedFileURL),
                      "the waiting draft was not adopted after Send another")
    }

    /// A failure card is the same: "Try again" must still return to the files
    /// that failed, not to a draft that arrived while the failure was showing.
    func testADraftArrivingOnAFailureWaitsForTryAgain() throws {
        let model = makeModel()
        let store = SelectionStore()
        let chosen = try file("chosen.txt")
        paneAdds([chosen], into: store, model: model)
        model.fail("no network")
        let coordinator = AppFileOpenCoordinator(navigation: AppNavigationModel(selection: .storedSend))
        coordinator.deliver([try file("draft.txt")])
        XCTAssertFalse(paneAdopts(coordinator, into: store, model: model))
        XCTAssertEqual(model.state, .failed("no network"))
        model.reset()
        XCTAssertTrue(paneAdopts(coordinator, into: store, model: model))
        XCTAssertEqual(Set(model.selectedFiles.map(\.name)), ["chosen.txt", "draft.txt"])
    }

    /// The choosing states still adopt immediately — the rule narrowed, it did
    /// not stop adoption.
    func testIdleAndPickedStillAdoptAndAppend() throws {
        let model = makeModel()
        XCTAssertTrue(model.acceptsOpenedFiles)
        let store = SelectionStore()
        paneAdds([try file("mine.txt")], into: store, model: model)
        XCTAssertTrue(model.acceptsOpenedFiles)
        let coordinator = AppFileOpenCoordinator(navigation: AppNavigationModel(selection: .storedSend))
        coordinator.deliver([try file("draft.txt")])
        XCTAssertTrue(paneAdopts(coordinator, into: store, model: model))
        XCTAssertEqual(Set(model.selectedFiles.map(\.name)), ["mine.txt", "draft.txt"],
                       "adoption must append to, never replace, the user's selection")
    }

    // ── M2: a selection survives the pane being rebuilt ────────────────────

    /// **Leaving Stored Send and coming back.** The shell rebuilds the pane —
    /// and its `@StateObject` store — while the model keeps `.picked`. Before
    /// A32 the new store was empty: Clear was hidden and the next pick replaced
    /// the draft. The pane now mirrors the model on appear.
    func testARebuiltPaneCanStillRemoveAndExtendTheAdoptedDraft() throws {
        let model = makeModel()
        let first = SelectionStore()
        let draft = try file("draft.txt")
        paneAdds([draft], into: first, model: model)

        let rebuilt = SelectionStore()           // navigate away and back
        rebuilt.mirror(model.state)              // the pane's `.onAppear`
        XCTAssertFalse(rebuilt.isEmpty, "the rebuilt pane has nothing to Clear")
        XCTAssertEqual(rebuilt.files, model.selectedFiles)

        paneAdds([try file("next.txt")], into: rebuilt, model: model)
        XCTAssertEqual(Set(model.selectedFiles.map(\.name)), ["draft.txt", "next.txt"],
                       "the next pick replaced the adopted draft")

        rebuilt.clear()                          // Clear → empty push
        model.clearSelection()
        XCTAssertEqual(model.state, .idle, "the draft could not be removed")
    }

    /// A folder comes back as that folder, so a later add re-expands it whole
    /// and the folder count survives.
    func testMirroringRebuildsFolderRootsFromRelativePaths() throws {
        try file("trip/day1/a.jpg")
        try file("trip/b.jpg")
        let loose = try file("loose.txt")
        let folder = root.appendingPathComponent("trip")
        let expanded = try expandSelection([folder, loose])

        let store = SelectionStore()
        store.mirror(.picked(expanded.files))
        XCTAssertEqual(store.roots.map(\.standardizedFileURL.path),
                       [folder, loose].map(\.standardizedFileURL.path))
        XCTAssertEqual(store.folderCount, 1)
        let revision = store.revision
        store.mirror(.picked(expanded.files))
        XCTAssertEqual(store.revision, revision, "mirroring must never push back to the model")
    }

    /// Only the choosing states are mirrored; `.idle` empties the store (an
    /// account change or a Clear from elsewhere), and the other states leave a
    /// refused selection visible beside its failure.
    func testMirrorFollowsOnlyTheChoosingStates() throws {
        let store = SelectionStore()
        store.add([try file("a.txt")])
        let before = store.roots
        store.mirror(.failed("x"))
        store.mirror(.uploading(sent: 0, total: 1))
        XCTAssertEqual(store.roots, before)
        store.mirror(.idle)
        XCTAssertTrue(store.isEmpty)
        XCTAssertTrue(store.roots.isEmpty)
    }

    // ── M3: a live session is not left behind ──────────────────────────────

    /// **A draft collected while the user is looking at a live session stages
    /// and stays put.** Before A32 every delivery navigated to Stored Send.
    func testADeliveryOverALiveSessionStagesWithoutNavigating() throws {
        let navigation = AppNavigationModel(selection: .nearby)
        let coordinator = AppFileOpenCoordinator(navigation: navigation)
        let draft = try file("draft.txt")
        coordinator.deliver([draft], keepsLiveSession: true)
        XCTAssertEqual(navigation.selection, .nearby, "the user was moved off a live session")
        XCTAssertEqual(navigation.selectionWrites, 0)
        XCTAssertEqual(coordinator.staged, OpenedFiles(destination: .storedSend, urls: [draft]),
                       "the batch must still be staged for the send flow")
        // And it is still adopted once the user goes there.
        XCTAssertNotNil(coordinator.batch(for: .storedSend, busy: false))
    }

    /// Without a live session, delivery still navigates exactly as before.
    func testADeliveryWithoutALiveSessionStillNavigates() throws {
        let navigation = AppNavigationModel(selection: .pairingCode)
        let coordinator = AppFileOpenCoordinator(navigation: navigation)
        coordinator.deliver([try file("draft.txt")], keepsLiveSession: false)
        XCTAssertEqual(navigation.selection, .storedSend)
        XCTAssertEqual(navigation.selectionWrites, 1)
    }

    // ── M4: nothing carries into the next account ──────────────────────────

    /// **A adopts a draft; B signs in → empty selection, nothing re-adopted.**
    func testADraftAdoptedUnderOneAccountDoesNotCarryIntoTheNext() throws {
        let model = makeModel()
        let store = SelectionStore()
        let coordinator = AppFileOpenCoordinator(navigation: AppNavigationModel(selection: .storedSend))
        XCTAssertFalse(coordinator.accountDidChange(to: "user-a"), "the first identity is not a change")
        coordinator.deliver([try file("draft.txt")])
        XCTAssertTrue(paneAdopts(coordinator, into: store, model: model))
        // A second draft still waiting (not yet adopted) when the account changes.
        coordinator.deliver([try file("late.txt")])
        XCTAssertFalse(model.selectedFiles.isEmpty)

        XCTAssertFalse(coordinator.accountDidChange(to: nil), "signing out is not the switch")
        XCTAssertTrue(coordinator.accountDidChange(to: "user-b"))
        model.forgetSelectionForAccountChange()
        store.mirror(model.state)                 // the pane's `.onChange(of: model.state)`

        XCTAssertEqual(model.state, .idle)
        XCTAssertTrue(model.sessionFiles.isEmpty)
        XCTAssertTrue(store.isEmpty)
        XCTAssertNil(coordinator.staged, "a batch staged under the previous account was kept")
        XCTAssertFalse(paneAdopts(coordinator, into: store, model: model),
                       "a previous account's draft was adopted into the next one")
        // And nothing brings it back: Send another/Try again restore `lastPicked`.
        model.reset()
        XCTAssertEqual(model.state, .idle, "reset restored the previous account's files")
    }

    /// Restoring the SAME account, or the first one after a cold launch, keeps
    /// a draft adopted before the keychain answered.
    func testRestoringTheSameAccountKeepsTheDraft() throws {
        let coordinator = AppFileOpenCoordinator(navigation: AppNavigationModel(selection: .storedSend))
        XCTAssertFalse(coordinator.accountDidChange(to: nil))
        coordinator.deliver([try file("draft.txt")])
        XCTAssertFalse(coordinator.accountDidChange(to: "user-a"))
        XCTAssertNotNil(coordinator.staged)
        XCTAssertFalse(coordinator.accountDidChange(to: nil))
        XCTAssertFalse(coordinator.accountDidChange(to: "user-a"))
        XCTAssertNotNil(coordinator.staged)
    }

    /// A finished link stays on screen across the switch — hiding the only copy
    /// of a key is not this event's to decide — but "Send another" must not
    /// restore the previous account's files.
    func testAFinishedLinkSurvivesTheSwitchButDoesNotRestoreItsFiles() async throws {
        let model = makeModel()
        let store = SelectionStore()
        paneAdds([try file("sent.txt")], into: store, model: model)
        await model.applyOutcome(UploadOutcome(id: "abc", expiresAt: 99, keyB64url: "KEY"))
        model.forgetSelectionForAccountChange()
        guard case .done = model.state else { return XCTFail("the finished link was hidden") }
        model.reset()
        XCTAssertEqual(model.state, .idle)
    }
}
