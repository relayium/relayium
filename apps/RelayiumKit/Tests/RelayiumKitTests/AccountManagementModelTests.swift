import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Lets a fake hold one call open, so a test can land a second operation in the
/// middle of the first one instead of hoping the scheduler interleaves them.
private actor Gate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var released = false
    func wait() async {
        if released { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        released = true
        for w in waiters { w.resume() }
        waiters = []
    }
}

private final class FakeManagementService: AccountManagementService, @unchecked Sendable {
    var devices: [AccountDevice] = []
    var files: [StoredFileSummary] = []
    var listDevicesError: Error?
    var listFilesError: Error?
    var deleteDeviceError: Error?
    var deleteFileError: Error?
    /// What a successful stored-file delete reports back.
    var deleteOutcome: StoredFileDeletion = .deleted

    private(set) var deletedDeviceIds: [String] = []
    private(set) var deletedFileIds: [String] = []
    private(set) var listCalls = 0
    private(set) var tokensSeen: [String] = []

    /// Holds list calls made with this token, so a slow load can be completed
    /// on purpose after something else has moved on.
    var gatedListToken: String?
    let listGate = Gate()
    /// The same for deletes. Separate from the list gate on purpose: a test that
    /// holds a refresh open usually needs a revoke to run to completion in the
    /// middle of it, and one shared gate would deadlock instead.
    var gatedActionToken: String?
    let actionGate = Gate()

    private func maybeWaitList(_ token: String) async {
        if let gatedListToken, gatedListToken == token { await listGate.wait() }
    }
    private func maybeWaitAction(_ token: String) async {
        if let gatedActionToken, gatedActionToken == token { await actionGate.wait() }
    }

    /// Snapshots before waiting, the way a real server's response reflects the
    /// state at the moment it was served. Without this, a held-open list call
    /// would return whatever the test mutated in the meantime and a
    /// stale-response test could never fail.
    func listDevices(token: String) async throws -> [AccountDevice] {
        listCalls += 1
        tokensSeen.append(token)
        let snapshot = devices
        await maybeWaitList(token)
        if let listDevicesError { throw listDevicesError }
        return snapshot
    }
    func listStoredFiles(token: String) async throws -> [StoredFileSummary] {
        let snapshot = files
        await maybeWaitList(token)
        if let listFilesError { throw listFilesError }
        return snapshot
    }
    func deleteDevice(id: String, token: String) async throws {
        await maybeWaitAction(token)
        if let deleteDeviceError { throw deleteDeviceError }
        deletedDeviceIds.append(id)
        devices.removeAll { $0.id == id }
    }
    func deleteStoredFile(id: String, token: String) async throws -> StoredFileDeletion {
        await maybeWaitAction(token)
        if let deleteFileError { throw deleteFileError }
        deletedFileIds.append(id)
        files.removeAll { $0.id == id }
        return deleteOutcome
    }
}

private func device(_ id: String, name: String = "d", kind: String = "app",
                    lastSeen: Int64 = 0, created: Int64 = 0,
                    current: Bool = false) -> AccountDevice {
    AccountDevice(id: id, name: name, createdAt: created, lastSeenAt: lastSeen,
                  kind: kind, current: current)
}

private func file(_ id: String, size: Int64 = 10, created: Int64 = 0,
                  expires: Int64 = 0, burn: Bool = false,
                  downloaded: Bool = false, count: Int = 0) -> StoredFileSummary {
    StoredFileSummary(id: id, size: size, createdAt: created, expiresAt: expires,
                      burnAfterRead: burn, downloaded: downloaded, downloadCount: count)
}

@MainActor
final class AccountManagementModelTests: XCTestCase {
    private var service = FakeManagementService()
    private var keys = InMemoryStoredLinkKeyStore()

    override func setUp() {
        service = FakeManagementService()
        keys = InMemoryStoredLinkKeyStore()
    }

    private func makeModel(keyStore: StoredLinkKeyStore? = nil) -> AccountManagementModel {
        AccountManagementModel(service: service, keyStore: keyStore ?? keys,
                               origin: "https://relayium.com")
    }
    private func scope(_ account: String = "u1", token: String = "tok") -> AccountScope {
        AccountScope(accountId: account, token: token)
    }

    // MARK: - loading

    func testStartsEmptyAndNotLoading() {
        let m = makeModel()
        XCTAssertTrue(m.devices.isEmpty)
        XCTAssertTrue(m.files.isEmpty)
        XCTAssertFalse(m.isLoading)
        XCTAssertNil(m.loadError)
        XCTAssertFalse(m.needsSignOut)
    }

    func testLoadFetchesDevicesAndFiles() async {
        service.devices = [device("d1", name: "Ada's Mac")]
        service.files = [file("f1", size: 42)]
        let m = makeModel()
        await m.load(scope())
        XCTAssertEqual(m.devices.map(\.id), ["d1"])
        XCTAssertEqual(m.files.map(\.id), ["f1"])
        XCTAssertEqual(m.files.first?.file.size, 42)
        XCTAssertFalse(m.isLoading)
        XCTAssertNil(m.loadError)
    }

    /// Browser rows are registered automatically by the website and hold a
    /// cookie, not a token that can be carried off a machine. Listing them buries
    /// the rows that matter.
    func testOnlyCliAndAppDevicesAreListed() async {
        service.devices = [
            device("browser1", kind: "browser"),
            device("legacy", kind: ""),
            device("cli1", kind: "cli"),
            device("app1", kind: "app"),
        ]
        let m = makeModel()
        await m.load(scope())
        XCTAssertEqual(Set(m.devices.map(\.id)), ["cli1", "app1"])
    }

    /// Most recently used first, matching the web's ordering, with a stable
    /// tie-break so the list does not reshuffle between refreshes.
    func testDevicesAreSortedByRecency() async {
        service.devices = [
            device("old", kind: "cli", lastSeen: 100, created: 1),
            device("never-b", kind: "cli", lastSeen: 0, created: 50),
            device("recent", kind: "app", lastSeen: 900, created: 2),
            device("never-a", kind: "cli", lastSeen: 0, created: 50),
        ]
        let m = makeModel()
        await m.load(scope())
        XCTAssertEqual(m.devices.map(\.id), ["recent", "old", "never-a", "never-b"])
    }

    func testStoredFilesAreSortedNewestFirst() async {
        service.files = [file("old", created: 10), file("new", created: 99), file("mid", created: 50)]
        let m = makeModel()
        await m.load(scope())
        XCTAssertEqual(m.files.map(\.id), ["new", "mid", "old"])
    }

    func testLoadFailureWithNothingOnScreenReportsTheError() async {
        service.listDevicesError = AccountError.network
        let m = makeModel()
        await m.load(scope())
        XCTAssertTrue(m.devices.isEmpty)
        XCTAssertEqual(m.loadError, ErrorCopy.message(for: AccountError.network))
        XCTAssertFalse(m.isLoading)
    }

    /// A refresh that fails must not blank a list that was true a moment ago —
    /// the same rule `AccountSession.isStale` follows for plan and usage.
    func testATransientRefreshFailureKeepsTheLastKnownGoodRows() async {
        service.devices = [device("d1")]
        service.files = [file("f1")]
        let m = makeModel()
        await m.load(scope())
        XCTAssertEqual(m.devices.count, 1)

        service.listDevicesError = AccountError.server(status: 502)
        service.listFilesError = AccountError.server(status: 502)
        await m.load(scope())
        XCTAssertEqual(m.devices.map(\.id), ["d1"], "rows were blanked by a failed refresh")
        XCTAssertEqual(m.files.map(\.id), ["f1"])
        XCTAssertEqual(m.loadError, ErrorCopy.message(for: AccountError.server(status: 502)))
    }

    /// One list failing must not discard the other list's fresh result.
    func testAPartialFailureStillAppliesTheHalfThatSucceeded() async {
        service.devices = [device("d1")]
        service.listFilesError = AccountError.server(status: 500)
        let m = makeModel()
        await m.load(scope())
        XCTAssertEqual(m.devices.map(\.id), ["d1"])
        XCTAssertNotNil(m.loadError)
    }

    func testASuccessfulReloadClearsAPreviousError() async {
        service.listDevicesError = AccountError.network
        let m = makeModel()
        await m.load(scope())
        XCTAssertNotNil(m.loadError)
        service.listDevicesError = nil
        service.devices = [device("d1")]
        await m.load(scope())
        XCTAssertNil(m.loadError)
        XCTAssertEqual(m.devices.map(\.id), ["d1"])
    }

    /// An expired bearer must not be reported with the sign-in form's copy about
    /// an email and a password the user never typed on this screen.
    func testAnExpiredBearerGetsItsOwnMessage() async {
        service.listDevicesError = AccountError.invalidCredentials
        let m = makeModel()
        await m.load(scope())
        XCTAssertNotNil(m.loadError)
        XCTAssertNotEqual(m.loadError, ErrorCopy.message(for: AccountError.invalidCredentials))
    }

    // MARK: - staleness

    /// The reason this state lives in a model rather than in the view: a load
    /// for the account the user just left completes after the new one, and the
    /// naive version paints a stranger's devices onto the current account.
    func testALateLoadFromAPreviousAccountDoesNotRepaintTheCurrentOne() async {
        service.gatedListToken = "old-token"
        service.devices = [device("old-device")]
        let m = makeModel()

        let slow = Task { await m.load(self.scope("old-user", token: "old-token")) }
        _ = await waitFor("the first load to reach the service") { self.service.listCalls == 1 }

        service.devices = [device("new-device")]
        await m.load(scope("new-user", token: "new-token"))
        XCTAssertEqual(m.devices.map(\.id), ["new-device"])

        await service.listGate.release()
        _ = await slow.value
        XCTAssertEqual(m.devices.map(\.id), ["new-device"],
                       "a load from the previous account repainted the current one")
    }

    /// Switching accounts must not leave the previous account's rows on screen
    /// while the new ones load.
    func testSwitchingAccountsClearsTheRowsImmediately() async {
        service.devices = [device("d1")]
        service.files = [file("f1")]
        let m = makeModel()
        await m.load(scope("u1"))
        XCTAssertEqual(m.devices.count, 1)

        service.gatedListToken = "t2"
        let pending = Task { await m.load(self.scope("u2", token: "t2")) }
        _ = await waitFor("the second load to start") { self.service.listCalls == 2 }
        XCTAssertTrue(m.devices.isEmpty, "the previous account's devices stayed on screen")
        XCTAssertTrue(m.files.isEmpty)
        await service.listGate.release()
        _ = await pending.value
    }

    /// A revoke that lands while a refresh is in flight must win: the refresh's
    /// older list still contains the row the user just removed.
    func testALoadInFlightDoesNotResurrectARevokedRow() async {
        service.devices = [device("d1"), device("d2")]
        let m = makeModel()
        await m.load(scope())

        service.gatedListToken = "tok"
        let refresh = Task { await m.load(self.scope()) }
        _ = await waitFor("the refresh to start") { self.service.listCalls == 2 }
        await m.revoke(device("d1"), scope: scope())
        XCTAssertEqual(m.devices.map(\.id), ["d2"])

        await service.listGate.release()
        _ = await refresh.value
        XCTAssertEqual(m.devices.map(\.id), ["d2"], "a stale refresh brought back a revoked device")
    }

    // MARK: - revoking

    func testRevokingADeviceRemovesItAndCallsTheServer() async {
        service.devices = [device("d1"), device("d2")]
        let m = makeModel()
        await m.load(scope())
        await m.revoke(device("d1"), scope: scope())
        XCTAssertEqual(service.deletedDeviceIds, ["d1"])
        XCTAssertEqual(m.devices.map(\.id), ["d2"])
        XCTAssertNil(m.error(forRow: "d1"))
        XCTAssertFalse(m.isBusy(row: "d1"))
    }

    /// Revoking the credential this Mac is holding cascades the token server
    /// side. Leaving the account screen up afterwards would be a UI claiming an
    /// authentication that no longer exists.
    func testRevokingThisMacAsksForASignOut() async {
        service.devices = [device("d1", current: true)]
        let m = makeModel()
        await m.load(scope())
        XCTAssertFalse(m.needsSignOut)
        await m.revoke(m.devices[0], scope: scope())
        XCTAssertTrue(m.needsSignOut)
    }

    func testRevokingAnotherDeviceDoesNotSignOut() async {
        service.devices = [device("d1", current: true), device("d2")]
        let m = makeModel()
        await m.load(scope())
        await m.revoke(device("d2"), scope: scope())
        XCTAssertFalse(m.needsSignOut)
    }

    /// The one that matters most: a failed self-revoke must leave the session
    /// alone. Signing out on a failure would destroy the local credential while
    /// the server-side one lives on — the opposite of what the user asked for.
    func testAFailedSelfRevokeDoesNotSignOut() async {
        service.devices = [device("d1", current: true)]
        service.deleteDeviceError = AccountError.server(status: 500)
        let m = makeModel()
        await m.load(scope())
        await m.revoke(m.devices[0], scope: scope())
        XCTAssertFalse(m.needsSignOut)
        XCTAssertEqual(m.devices.map(\.id), ["d1"], "the row was removed despite the failure")
        XCTAssertNotNil(m.error(forRow: "d1"))
    }

    func testAFailedRevokeReportsOnThatRowOnly() async {
        service.devices = [device("d1"), device("d2")]
        service.deleteDeviceError = AccountError.network
        let m = makeModel()
        await m.load(scope())
        await m.revoke(device("d1"), scope: scope())
        XCTAssertEqual(m.error(forRow: "d1"), ErrorCopy.message(for: AccountError.network))
        XCTAssertNil(m.error(forRow: "d2"))
        XCTAssertNil(m.loadError, "a row action must not raise the whole-list error")
    }

    func testRetryingAFailedRevokeClearsItsError() async {
        service.devices = [device("d1")]
        service.deleteDeviceError = AccountError.network
        let m = makeModel()
        await m.load(scope())
        await m.revoke(device("d1"), scope: scope())
        XCTAssertNotNil(m.error(forRow: "d1"))
        service.deleteDeviceError = nil
        await m.revoke(device("d1"), scope: scope())
        XCTAssertNil(m.error(forRow: "d1"))
        XCTAssertTrue(m.devices.isEmpty)
    }

    /// Only the row being changed goes busy: the rest of the list stays usable.
    func testOnlyTheRowBeingChangedIsBusy() async {
        service.devices = [device("d1"), device("d2")]
        let m = makeModel()
        await m.load(scope())
        service.gatedActionToken = "tok"

        let pending = Task { await m.revoke(device("d1"), scope: self.scope()) }
        _ = await waitFor("the revoke to be in flight") { m.isBusy(row: "d1") }
        XCTAssertFalse(m.isBusy(row: "d2"))
        await service.actionGate.release()
        _ = await pending.value
        XCTAssertFalse(m.isBusy(row: "d1"))
    }

    /// A revoke that completes after the user signed in as someone else must not
    /// remove a row from the new account's list.
    func testALateRevokeDoesNotMutateANewAccount() async {
        service.devices = [device("d1")]
        let m = makeModel()
        await m.load(scope("u1", token: "old"))
        service.gatedActionToken = "old"

        let pending = Task { await m.revoke(device("d1"), scope: self.scope("u1", token: "old")) }
        _ = await waitFor("the revoke to be in flight") { m.isBusy(row: "d1") }

        service.devices = [device("d1", name: "someone else's device")]
        await m.load(scope("u2", token: "new"))
        XCTAssertEqual(m.devices.map(\.id), ["d1"])

        await service.actionGate.release()
        _ = await pending.value
        XCTAssertEqual(m.devices.map(\.id), ["d1"],
                       "a revoke from the previous account removed a row from the new one")
        XCTAssertFalse(m.isBusy(row: "d1"))
    }

    /// Signing out and back in as the SAME account changes the credential but not
    /// the account, so the rows are deliberately not cleared. An action still in
    /// flight from the old credential lands afterwards and is correctly ignored —
    /// but it must not leave its row disabled with nothing left to finish it.
    func testALateActionAfterATokenChangeDoesNotStrandTheRowAsBusy() async {
        service.devices = [device("d1")]
        let m = makeModel()
        await m.load(scope("u1", token: "old"))
        service.gatedActionToken = "old"

        let pending = Task { await m.revoke(device("d1"), scope: self.scope("u1", token: "old")) }
        _ = await waitFor("the revoke to be in flight") { m.isBusy(row: "d1") }

        await m.load(scope("u1", token: "new"))
        XCTAssertEqual(m.devices.map(\.id), ["d1"])

        await service.actionGate.release()
        _ = await pending.value
        XCTAssertFalse(m.isBusy(row: "d1"), "the row is stuck disabled with nothing left to finish it")
        XCTAssertEqual(m.devices.map(\.id), ["d1"], "a revoke from a replaced credential mutated the list")
    }

    // MARK: - stored files and their keys

    /// The link can only be rebuilt where the key is. That is the product's
    /// guarantee, not a limitation to work around: the server never had it.
    func testALinkIsOfferedOnlyWhenThisMacHoldsTheKey() async throws {
        try await keys.save(id: "mine", keyB64url: "KEY123")
        service.files = [file("mine", created: 2), file("elsewhere", created: 1)]
        let m = makeModel()
        await m.load(scope())
        XCTAssertEqual(m.files[0].link, .available(link: "https://relayium.com/d/mine#k=KEY123"))
        XCTAssertEqual(m.files[1].link, .keyNotOnThisMac)
    }

    /// "The keychain would not answer" is not "you do not have the key". Saying
    /// the second when the first happened tells the user their file is
    /// unrecoverable when it may be one unlock away.
    func testAKeychainFailureIsNotReportedAsAMissingKey() async {
        let m = AccountManagementModel(service: service,
                                       keyStore: FailingKeyStore(),
                                       origin: "https://relayium.com")
        service.files = [file("f1")]
        await m.load(scope())
        guard case .keyLookupFailed = m.files[0].link else {
            return XCTFail("got \(m.files[0].link)")
        }
    }

    /// And what that state SAYS is about the read that failed. The keychain
    /// raises the same `KeychainError` the sign-in token store does, whose copy
    /// promises the user will stay signed in until they quit — a statement about
    /// a session that nothing here touched, shown because they asked to list
    /// their files.
    func testAKeychainFailureIsDescribedAsAKeyReadAndNotAsASignInProblem() async {
        let m = makeModel(keyStore: FailingKeyStore())
        service.files = [file("f1")]
        await m.load(scope())
        guard case .keyLookupFailed(let message) = m.files[0].link else {
            return XCTFail("got \(m.files[0].link)")
        }
        assertSaysNothingAboutSigningIn(message, "the key-lookup failure")
        XCTAssertTrue(message.lowercased().contains("read"), "it does not say the read failed: \(message)")
        XCTAssertTrue(message.lowercased().contains("keychain"), message)
        XCTAssertTrue(message.contains("-25308"), "the keychain status was dropped: \(message)")
    }

    /// The refusals the app raises itself need the same treatment. Their shared
    /// copy is `AccountClient`'s — an id refused BEFORE a DELETE was sent — and
    /// the request behind this row already came back, so wording that reads as
    /// "nothing went out" describes a different failure than the one that
    /// happened.
    func testAKeyLookupTheAppRefusesIsDescribedAsAFailedRead() async {
        for e in [StoredLinkKeyError.invalidKey, .invalidIdentifier] {
            service.files = [file("f1")]
            let m = makeModel(keyStore: RefusingKeyStore(error: e))
            await m.load(scope())
            guard case .keyLookupFailed(let message) = m.files[0].link else {
                return XCTFail("got \(m.files[0].link) for \(e)")
            }
            assertSaysNothingAboutSigningIn(message, "the \(e) key-lookup failure")
            assertDoesNotDenyACompletedRequest(message, "the \(e) key-lookup failure")
            XCTAssertTrue(message.lowercased().contains("read"),
                          "it does not say the read failed for \(e): \(message)")
        }
    }

    func testDeletingAStoredFileRemovesItAndItsKey() async throws {
        try await keys.save(id: "f1", keyB64url: "KEY123")
        service.files = [file("f1"), file("f2")]
        let m = makeModel()
        await m.load(scope())
        await m.delete(file("f1"), scope: scope())
        XCTAssertEqual(service.deletedFileIds, ["f1"])
        XCTAssertEqual(m.files.map(\.id), ["f2"])
        let leftover = try await keys.key(for: "f1")
        XCTAssertNil(leftover, "the key outlived the ciphertext it belonged to")
    }

    /// The server answers 404 for an object that is missing, expired or burned —
    /// and for a read that failed on its side. Those are indistinguishable from
    /// here, and the two mistakes are not symmetric: keeping a key for something
    /// that is gone leaves an inert keychain item, while dropping a key for
    /// something that still exists destroys the only way to open it. So an
    /// unconfirmed delete takes the row off the list and keeps the key.
    func testAnUnconfirmedDeleteRemovesTheRowButKeepsTheKey() async throws {
        try await keys.save(id: "f1", keyB64url: "KEY123")
        service.files = [file("f1")]
        service.deleteOutcome = .alreadyGone
        let m = makeModel()
        await m.load(scope())
        await m.delete(file("f1"), scope: scope())
        XCTAssertTrue(m.files.isEmpty, "the row stayed on a list where the object is gone")
        XCTAssertNil(m.error(forRow: "f1"))
        let kept = try await keys.key(for: "f1")
        XCTAssertEqual(kept, "KEY123", "a key was destroyed on an unconfirmed delete")
    }

    /// A failed delete must keep both the row and its key: the object is still
    /// on the server, and dropping the key would make it permanently unopenable.
    func testAFailedDeleteKeepsTheRowAndTheKey() async throws {
        try await keys.save(id: "f1", keyB64url: "KEY123")
        service.files = [file("f1")]
        service.deleteFileError = AccountError.server(status: 500)
        let m = makeModel()
        await m.load(scope())
        await m.delete(file("f1"), scope: scope())
        XCTAssertEqual(m.files.map(\.id), ["f1"])
        XCTAssertNotNil(m.error(forRow: "f1"))
        let kept = try await keys.key(for: "f1")
        XCTAssertEqual(kept, "KEY123")
    }

    /// A key saved by an upload has to be the same key this list reads back —
    /// the whole point of sharing one store between the two.
    func testAKeySavedAfterLoadingShowsUpOnTheNextRefresh() async throws {
        service.files = [file("f1")]
        let m = makeModel()
        await m.load(scope())
        XCTAssertEqual(m.files[0].link, .keyNotOnThisMac)
        try await keys.save(id: "f1", keyB64url: "LATER")
        await m.load(scope())
        XCTAssertEqual(m.files[0].link, .available(link: "https://relayium.com/d/f1#k=LATER"))
    }

    /// A confirmed server delete whose local cleanup fails is NOT a failed
    /// delete: the ciphertext is gone, and reporting an error would send the
    /// user to retry an operation that already succeeded. It is not silence
    /// either — the app would otherwise imply it removed a key it still holds.
    func testAConfirmedDeleteWhoseKeyRemovalFailsStillRemovesTheRowAndSaysSo() async {
        let store = RemoveFailingKeyStore()
        try? await store.save(id: "f1", keyB64url: "KEY123")
        service.files = [file("f1"), file("f2")]
        let m = makeModel(keyStore: store)
        await m.load(scope())
        XCTAssertNil(m.keyCleanupWarning)

        await m.delete(file("f1"), scope: scope())
        XCTAssertEqual(service.deletedFileIds, ["f1"], "the server delete did not happen")
        XCTAssertEqual(m.files.map(\.id), ["f2"], "a confirmed server delete left its row on screen")
        XCTAssertNil(m.error(forRow: "f1"), "a local cleanup failure was reported as a failed delete")
        XCTAssertNil(m.loadError)
        guard let warning = m.keyCleanupWarning else {
            return XCTFail("the app silently kept a key it implied it had removed")
        }
        XCTAssertTrue(warning.contains("f1"), "the warning does not name the file: \(warning)")
    }

    /// And it describes the cleanup. This is the third place `KeychainError`
    /// surfaces without a sign-in anywhere near it: the ciphertext is already
    /// gone from the server, the session is untouched, and the one fact left to
    /// report is that an obsolete key is still in this Mac's keychain.
    func testAFailedKeyCleanupIsDescribedAsACleanupAndNotAsASignInProblem() async {
        let store = RemoveFailingKeyStore()
        try? await store.save(id: "f1", keyB64url: "KEY123")
        service.files = [file("f1")]
        let m = makeModel(keyStore: store)
        await m.load(scope())
        await m.delete(file("f1"), scope: scope())
        guard let warning = m.keyCleanupWarning else {
            return XCTFail("the app silently kept a key it implied it had removed")
        }
        assertSaysNothingAboutSigningIn(warning, "the key-cleanup warning")
        XCTAssertTrue(warning.lowercased().contains("remove"), "it does not say what failed: \(warning)")
        XCTAssertTrue(warning.lowercased().contains("keychain"), warning)
        XCTAssertTrue(warning.contains("-25308"), "the keychain status was dropped: \(warning)")
        XCTAssertTrue(warning.contains("f1"), warning)
    }

    /// And so does a cleanup the app itself refuses. This warning follows a
    /// CONFIRMED server delete, so the one thing it must never do is read as
    /// though the delete had not happened — which is precisely what the shared
    /// wording, written for an id refused before the DELETE went out, does.
    func testAKeyCleanupTheAppRefusesSaysSoWithoutDenyingTheDelete() async {
        for e in [StoredLinkKeyError.invalidKey, .invalidIdentifier] {
            let store = RemoveRefusingKeyStore(e)
            try? await store.save(id: "f1", keyB64url: "KEY123")
            service.files = [file("f1")]
            let m = makeModel(keyStore: store)
            await m.load(scope())
            await m.delete(file("f1"), scope: scope())
            XCTAssertNil(m.error(forRow: "f1"),
                         "a local cleanup failure was reported as a failed delete for \(e)")
            guard let warning = m.keyCleanupWarning else {
                return XCTFail("the app silently kept a key it implied it had removed, for \(e)")
            }
            assertSaysNothingAboutSigningIn(warning, "the \(e) key-cleanup warning")
            assertDoesNotDenyACompletedRequest(warning, "the \(e) key-cleanup warning")
            XCTAssertTrue(warning.lowercased().contains("remove"),
                          "it does not say what failed for \(e): \(warning)")
            XCTAssertTrue(warning.contains("f1"), warning)
        }
    }

    /// The 404 path never attempts the removal — the key is deliberately kept
    /// because a 404 is also what a failed read on the server looks like — so
    /// there is nothing to warn about. A warning here would be a lie in the
    /// other direction.
    func testAnUnconfirmedDeleteRaisesNoCleanupWarning() async {
        let store = RemoveFailingKeyStore()
        try? await store.save(id: "f1", keyB64url: "KEY123")
        service.files = [file("f1")]
        service.deleteOutcome = .alreadyGone
        let m = makeModel(keyStore: store)
        await m.load(scope())
        await m.delete(file("f1"), scope: scope())
        XCTAssertTrue(m.files.isEmpty)
        XCTAssertNil(m.keyCleanupWarning)
        let kept = try? await store.key(for: "f1")
        XCTAssertEqual(kept, "KEY123", "a key was destroyed on an unconfirmed delete")
    }

    /// A delete the server refused is a row error, not a cleanup warning: the
    /// object is still there and the key must stay with it.
    func testAFailedServerDeleteRaisesNoCleanupWarning() async {
        service.files = [file("f1")]
        service.deleteFileError = AccountError.server(status: 500)
        let m = makeModel(keyStore: RemoveFailingKeyStore())
        await m.load(scope())
        await m.delete(file("f1"), scope: scope())
        XCTAssertNotNil(m.error(forRow: "f1"))
        XCTAssertNil(m.keyCleanupWarning)
    }

    func testTheCleanupWarningIsDismissible() async {
        let store = RemoveFailingKeyStore()
        service.files = [file("f1")]
        let m = makeModel(keyStore: store)
        await m.load(scope())
        await m.delete(file("f1"), scope: scope())
        XCTAssertNotNil(m.keyCleanupWarning)
        m.dismissKeyCleanupWarning()
        XCTAssertNil(m.keyCleanupWarning)
    }

    // MARK: - leaving an account

    /// This model outlives the window, so signing out otherwise leaves the
    /// previous account's rows — and the rebuilt `#k=` links, each of which
    /// grants plaintext to whoever holds it — in memory behind a signed-out
    /// screen. Nothing draws them, but "not drawn" is a weaker promise than
    /// "not held".
    func testClearingDropsEveryRowAndEveryReconstructedLink() async throws {
        try await keys.save(id: "f1", keyB64url: "KEY123")
        service.devices = [device("d1")]
        service.files = [file("f1")]
        let m = makeModel()
        await m.load(scope("u1"))
        XCTAssertEqual(m.files.first?.link, .available(link: "https://relayium.com/d/f1#k=KEY123"))

        m.clear(scope: scope("u1"))
        XCTAssertTrue(m.devices.isEmpty)
        XCTAssertTrue(m.files.isEmpty, "a signed-out account's links stayed in memory")
        XCTAssertNil(m.loadError)
        XCTAssertFalse(m.needsSignOut)
    }

    /// Scope-aware, because a clear can race a sign-in as somebody else: the
    /// Refresh button's own guard can call it after the new account has already
    /// loaded. Wiping the new account's rows would be the same class of bug in
    /// the other direction.
    func testClearingAnotherAccountsScopeLeavesTheCurrentRowsAlone() async {
        service.devices = [device("d1")]
        let m = makeModel()
        await m.load(scope("u2", token: "t2"))
        m.clear(scope: scope("u1", token: "t1"))
        XCTAssertEqual(m.devices.map(\.id), ["d1"], "another account's clear wiped the current rows")
    }

    /// A token refresh in between must not stop a sign-out from taking effect —
    /// the caller is saying "the user left this account", not "this credential".
    func testClearingMatchesTheAccountRatherThanTheCredential() async {
        service.devices = [device("d1")]
        let m = makeModel()
        await m.load(scope("u1", token: "current"))
        m.clear(scope: scope("u1", token: "the-token-this-screen-rendered-with"))
        XCTAssertTrue(m.devices.isEmpty)
    }

    /// The clear is only worth anything if a load already in flight cannot put
    /// the rows straight back a moment later — and if it does not leave the
    /// model believing it is still loading. The suspended load returns to its
    /// staleness guard and bails out BEFORE the line that lowers `isLoading`, so
    /// the clear is the only thing that can lower it. This model is app-scoped,
    /// so nothing else would: signing out would hand the next sign-in a spinner
    /// it never started.
    func testALoadInFlightWhenClearedDoesNotRepaint() async {
        service.gatedListToken = "tok"
        service.devices = [device("d1")]
        service.files = [file("f1")]
        let m = makeModel()

        let pending = Task { await m.load(self.scope("u1")) }
        _ = await waitFor("the load to reach the service") { self.service.listCalls == 1 }
        XCTAssertTrue(m.isLoading, "a first load with nothing on screen never reported itself as loading")
        m.clear(scope: scope("u1"))
        XCTAssertFalse(m.isLoading, "the clear left the model loading with no load left to finish")

        await service.listGate.release()
        _ = await pending.value
        XCTAssertTrue(m.devices.isEmpty, "a load that started before the clear repainted after it")
        XCTAssertTrue(m.files.isEmpty)
        XCTAssertFalse(m.isLoading, "the stale load's return left the model loading")
    }

    /// The same for an action. A self-revoke landing after the clear would
    /// otherwise raise `needsSignOut` on a model that no longer belongs to any
    /// account — and sign the NEXT session out.
    func testALateSelfRevokeAfterAClearDoesNotAskToSignOutAgain() async {
        service.devices = [device("d1", current: true)]
        let m = makeModel()
        await m.load(scope("u1"))
        service.gatedActionToken = "tok"

        let pending = Task { await m.revoke(device("d1", current: true), scope: self.scope("u1")) }
        _ = await waitFor("the revoke to be in flight") { m.isBusy(row: "d1") }
        m.clear(scope: scope("u1"))

        await service.actionGate.release()
        _ = await pending.value
        XCTAssertFalse(m.needsSignOut, "a revoke that landed after the clear asked for another sign-out")
        XCTAssertTrue(m.devices.isEmpty)
        XCTAssertFalse(m.isBusy(row: "d1"))
    }

    /// After a clear the model belongs to nobody, so the next account loads from
    /// empty rather than inheriting anything.
    func testLoadingAfterAClearStartsFromNothing() async {
        service.devices = [device("d1")]
        let m = makeModel()
        await m.load(scope("u1"))
        m.clear(scope: scope("u1"))
        service.devices = [device("d2")]
        await m.load(scope("u2", token: "t2"))
        XCTAssertEqual(m.devices.map(\.id), ["d2"])
    }

    func testClearingDropsAPendingCleanupWarning() async {
        service.files = [file("f1")]
        let m = makeModel(keyStore: RemoveFailingKeyStore())
        await m.load(scope("u1"))
        await m.delete(file("f1"), scope: scope("u1"))
        XCTAssertNotNil(m.keyCleanupWarning)
        m.clear(scope: scope("u1"))
        XCTAssertNil(m.keyCleanupWarning)
    }

    func testSignOutSignalIsAcknowledgeable() async {
        service.devices = [device("d1", current: true)]
        let m = makeModel()
        await m.load(scope())
        await m.revoke(m.devices[0], scope: scope())
        XCTAssertTrue(m.needsSignOut)
        m.acknowledgeSignOut()
        XCTAssertFalse(m.needsSignOut)
    }

    // MARK: - where Refresh goes afterwards

    /// Built from the same server-frozen fixtures `AccountSessionTests` uses, so
    /// `.ready` here is the shape a real `/api/me` produces rather than a
    /// hand-made one that might not be reachable.
    private func ready(_ id: String) throws -> SessionState {
        let dir = Bundle.module.url(forResource: "me", withExtension: "json")!
        var user = try JSONDecoder().decode(MeResponse.self, from: Data(contentsOf: dir)).user
        user.id = id
        let usageURL = Bundle.module.url(forResource: "me-usage", withExtension: "json")!
        let usage = try JSONDecoder().decode(UsageResponse.self, from: Data(contentsOf: usageURL))
        return .ready(user: user, usage: usage)
    }

    func testRefreshReloadsWhenTheSameAccountIsStillSignedIn() throws {
        let previous = scope("u1", token: "old")
        XCTAssertEqual(
            AccountRefreshDecision.next(previous: previous, state: try ready("u1"), bearer: "old"),
            .reload(AccountScope(accountId: "u1", token: "old")))
    }

    /// A refresh can rotate the credential. The reload has to go out under the
    /// one the session holds NOW, not the one the screen was rendered with.
    func testRefreshReloadsUnderTheCredentialTheSessionHoldsNow() throws {
        let previous = scope("u1", token: "old")
        XCTAssertEqual(
            AccountRefreshDecision.next(previous: previous, state: try ready("u1"), bearer: "rotated"),
            .reload(AccountScope(accountId: "u1", token: "rotated")))
    }

    /// The defect this exists for: an expired bearer sends the session to
    /// `.loggedOut`, and the view's recomputed scope then pairs the OLD user id
    /// with an EMPTY token. Loading with that asks the server for an account's
    /// devices with no credential at all.
    func testRefreshClearsWhenTheSessionEnded() {
        let previous = scope("u1", token: "old")
        for state: SessionState in [.loggedOut, .restoring, .authenticating,
                                    .failed(message: "no"), .unavailable(message: "down"),
                                    .emailUnverified(email: "a@b.c")] {
            XCTAssertEqual(
                AccountRefreshDecision.next(previous: previous, state: state, bearer: nil),
                .clear(previous), "state \(state)")
        }
    }

    /// `.unavailable` deliberately KEEPS the token so the user can retry, so a
    /// nonempty bearer is not on its own evidence that an account is on screen.
    func testRefreshClearsWhenATokenSurvivesButNoAccountIsReady() {
        let previous = scope("u1", token: "old")
        XCTAssertEqual(
            AccountRefreshDecision.next(previous: previous,
                                        state: .unavailable(message: "server down"),
                                        bearer: "still-held"),
            .clear(previous))
    }

    /// A second sign-in as somebody else. Reloading would fetch the new user's
    /// rows under the old account's identity — the exact confusion the scope
    /// exists to prevent.
    func testRefreshClearsWhenTheAccountChanged() throws {
        let previous = scope("u1", token: "old")
        XCTAssertEqual(
            AccountRefreshDecision.next(previous: previous, state: try ready("u2"), bearer: "new"),
            .clear(previous))
    }

    func testRefreshClearsWhenReadyButTheBearerIsEmpty() throws {
        let previous = scope("u1", token: "old")
        XCTAssertEqual(
            AccountRefreshDecision.next(previous: previous, state: try ready("u1"), bearer: ""),
            .clear(previous))
    }

    // MARK: - helpers

    private func waitFor(_ what: String, seconds: TimeInterval = 5,
                         _ ready: @MainActor () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if ready() { return true }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("timed out waiting for \(what)")
        return false
    }
}

/// Stands in for a keychain that is present but will not answer — locked, or
/// refusing this process. Distinct from "no key stored", which is `nil`.
private struct FailingKeyStore: StoredLinkKeyStore {
    func save(id: String, keyB64url: String) async throws { throw KeychainError.status(-25308) }
    func key(for id: String) async throws -> String? { throw KeychainError.status(-25308) }
    func remove(id: String) async throws { throw KeychainError.status(-25308) }
}

/// Saves and reads normally but cannot delete — the one shape that matters for
/// the delete path, because it happens AFTER the server has already destroyed
/// the ciphertext and there is no operation left to retry.
private final class RemoveFailingKeyStore: StoredLinkKeyStore, @unchecked Sendable {
    private let inner = InMemoryStoredLinkKeyStore()
    func save(id: String, keyB64url: String) async throws {
        try await inner.save(id: id, keyB64url: keyB64url)
    }
    func key(for id: String) async throws -> String? { try await inner.key(for: id) }
    func remove(id: String) async throws { throw KeychainError.status(-25308) }
}

/// The app's own validation refusing, rather than the keychain refusing to
/// answer: an id it will not compose into an account name, or stored bytes that
/// are not a usable key. A different failure with the same surface, and one
/// whose shared copy was written for a caller that never touches this store.
private struct RefusingKeyStore: StoredLinkKeyStore {
    let error: StoredLinkKeyError
    func save(id: String, keyB64url: String) async throws { throw error }
    func key(for id: String) async throws -> String? { throw error }
    func remove(id: String) async throws { throw error }
}

/// `RemoveFailingKeyStore`'s counterpart for those refusals: saves and reads
/// normally so the cleanup path has a key to fail on.
private final class RemoveRefusingKeyStore: StoredLinkKeyStore, @unchecked Sendable {
    private let inner = InMemoryStoredLinkKeyStore()
    private let error: StoredLinkKeyError
    init(_ error: StoredLinkKeyError) { self.error = error }
    func save(id: String, keyB64url: String) async throws {
        try await inner.save(id: id, keyB64url: keyB64url)
    }
    func key(for id: String) async throws -> String? { try await inner.key(for: id) }
    func remove(id: String) async throws { throw error }
}
