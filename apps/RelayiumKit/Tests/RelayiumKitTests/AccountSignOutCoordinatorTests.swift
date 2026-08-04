import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// The hand-off that has to happen whether or not the account screen exists.
///
/// Revoking the current device kills this app's bearer server-side. Until R3-D's
/// review the app noticed by way of a `.task(id:)` on the account view — which
/// meant a user who tapped Revoke and immediately switched tabs took the
/// observer down before the response arrived. The model kept the signal, so
/// nothing was lost; but nothing CONSUMED it either, and until the user wandered
/// back to the Account tab the other tabs went on offering to spend a credential
/// the server had already revoked.
///
/// So the observer is app-scoped and subscribes before any view exists, and
/// these tests drive it with no view at all — which is the whole claim.
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

private final class StubService: AccountManagementService, @unchecked Sendable {
    var devices: [AccountDevice] = []
    var files: [StoredFileSummary] = []
    var deleteDeviceError: Error?
    func listDevices(token: String) async throws -> [AccountDevice] { devices }
    func listStoredFiles(token: String) async throws -> [StoredFileSummary] { files }
    func deleteDevice(id: String, token: String) async throws {
        if let deleteDeviceError { throw deleteDeviceError }
        devices.removeAll { $0.id == id }
    }
    func deleteStoredFile(id: String, token: String) async throws -> StoredFileDeletion {
        files.removeAll { $0.id == id }
        return .deleted
    }
}

/// Stands in for `AccountSession.logOut()`: countable, and holdable open so a
/// test can look at the app WHILE the network call is in flight — which is the
/// window every claim here is about.
@MainActor
private final class LogOutSpy {
    private(set) var calls = 0
    let gate = Gate()
    var isGated = false

    func callAsFunction() async {
        calls += 1
        if isGated { await gate.wait() }
    }
}

@MainActor
final class AccountSignOutCoordinatorTests: XCTestCase {
    private var service = StubService()
    private var keys = InMemoryStoredLinkKeyStore()
    private var spy = LogOutSpy()

    override func setUp() {
        service = StubService()
        keys = InMemoryStoredLinkKeyStore()
        spy = LogOutSpy()
    }

    private func makeModel() -> AccountManagementModel {
        AccountManagementModel(service: service, keyStore: keys,
                               origin: "https://relayium.com")
    }

    private func makeCoordinator(_ m: AccountManagementModel) -> AccountSignOutCoordinator {
        let spy = self.spy
        let c = AccountSignOutCoordinator(management: m, logOut: { await spy() })
        c.observe(m.$needsSignOut)
        return c
    }

    private func device(_ id: String, current: Bool = false) -> AccountDevice {
        AccountDevice(id: id, name: id, createdAt: 0, lastSeenAt: 0,
                      kind: "app", current: current)
    }

    private func scope(_ account: String = "u1", token: String = "tok") -> AccountScope {
        AccountScope(accountId: account, token: token)
    }

    // MARK: - the defect this type exists for

    /// No view, ever. The revoke happens, and the sign-out follows.
    func testASelfRevokeIsHandledWithNoAccountViewMounted() async {
        service.devices = [device("d1", current: true)]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope())

        await m.revoke(device("d1", current: true), scope: scope())
        _ = await waitFor("the shell to claim the signal") { self.spy.calls == 1 }
        XCTAssertFalse(m.needsSignOut, "the signal was never claimed")
        _ = c
    }

    /// And the rows are gone BEFORE the network call returns, not after it.
    ///
    /// `logOut` can take a minute to time out. For that whole minute the rows
    /// include reconstructed `#k=` links — each one the plaintext of a stored
    /// file to anybody holding it — belonging to an account whose credential is
    /// already dead. There is no version of this where waiting is right.
    func testTheRowsAndLinksAreGoneBeforeTheLogoutReturns() async throws {
        try await keys.save(id: "f1", keyB64url: "AAAA")
        service.devices = [device("d1", current: true)]
        service.files = [StoredFileSummary(id: "f1", size: 1, createdAt: 0, expiresAt: 0,
                                           burnAfterRead: false, downloaded: false,
                                           downloadCount: 0)]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope())
        guard case .available = m.files[0].link else { return XCTFail("no link to drop") }
        spy.isGated = true

        await m.revoke(device("d1", current: true), scope: scope())
        _ = await waitFor("the logout to start") { self.spy.calls == 1 }
        XCTAssertTrue(m.devices.isEmpty, "a revoked account's devices outlived the request")
        XCTAssertTrue(m.files.isEmpty, "a reconstructed #k= link outlived the request")
        XCTAssertTrue(c.isSigningOut, "nothing told the app a sign-out was running")

        await spy.gate.release()
        _ = await waitFor("the sign-out to finish") { !c.isSigningOut }
    }

    /// Every tab is blocked while the call is in flight, and stops being blocked
    /// when it ends — including when it ENDS BADLY. A failed sign-out leaves the
    /// user on a retryable screen; a permanently disabled app would leave them
    /// with nothing to retry it from.
    func testTheBusySignalIsRaisedForTheCallAndLoweredEitherWay() async {
        service.devices = [device("d1", current: true)]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope())
        XCTAssertFalse(c.isSigningOut, "the app started out blocked")
        spy.isGated = true

        await m.revoke(device("d1", current: true), scope: scope())
        _ = await waitFor("the block to go up") { c.isSigningOut }
        await spy.gate.release()
        _ = await waitFor("the block to come down") { !c.isSigningOut }
    }

    // MARK: - one logout, ever

    /// The user taps Sign out while a self-revoke's sign-out is already running.
    /// Two `logout` calls would be two revocations of a credential that is
    /// already gone, and the second one's failure would be reported over the
    /// first one's success.
    func testAnExplicitSignOutDuringASelfRevokeDoesNotStartASecondLogout() async {
        service.devices = [device("d1", current: true)]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope())
        spy.isGated = true

        await m.revoke(device("d1", current: true), scope: scope())
        _ = await waitFor("the first logout") { self.spy.calls == 1 }
        c.signOut(scope: scope())
        c.signOut(scope: scope())
        await spy.gate.release()
        _ = await waitFor("the sign-out to finish") { !c.isSigningOut }
        XCTAssertEqual(spy.calls, 1, "the app signed out more than once")
    }

    /// And the other way round: a self-revoke landing while an explicit sign-out
    /// is in flight still CLAIMS the signal — otherwise it would survive into
    /// the next session and sign that one out — but starts no second call.
    func testASelfRevokeDuringAnExplicitSignOutIsClaimedWithoutASecondLogout() async {
        service.devices = [device("d1", current: true)]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope())
        spy.isGated = true

        c.signOut(scope: scope())
        _ = await waitFor("the explicit logout") { self.spy.calls == 1 }
        await m.revoke(device("d1", current: true), scope: scope())
        _ = await waitFor("the signal to be claimed") { !m.needsSignOut }

        await spy.gate.release()
        _ = await waitFor("the sign-out to finish") { !c.isSigningOut }
        XCTAssertEqual(spy.calls, 1, "the app signed out more than once")
    }

    // MARK: - the explicit sign-out keeps its own guarantees

    func testAnExplicitSignOutDropsTheScopedRowsBeforeTheCall() async {
        service.devices = [device("d1")]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope("u1"))
        spy.isGated = true

        c.signOut(scope: scope("u1"))
        XCTAssertTrue(m.devices.isEmpty, "the rows were still held when the request went out")
        _ = await waitFor("the logout") { self.spy.calls == 1 }
        await spy.gate.release()
        _ = await waitFor("the sign-out to finish") { !c.isSigningOut }
    }

    /// The scope still means something: a stale button press naming an account
    /// the model has already moved on from must not wipe the current one's rows.
    func testAnExplicitSignOutForAnotherAccountLeavesTheCurrentRowsAlone() async {
        service.devices = [device("d1")]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope("u2", token: "t2"))

        c.signOut(scope: scope("u1"))
        XCTAssertEqual(m.devices.map(\.id), ["d1"],
                       "a stale sign-out cleared the account that replaced it")
    }

    // MARK: - a fresh signal is still handled

    /// Claiming one signal must not deafen the observer to the next: signing in
    /// again on the same launch and revoking that device too has to work.
    func testASecondSelfRevokeInTheSameLaunchIsHandledAgain() async {
        service.devices = [device("d1", current: true)]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope("u1"))
        await m.revoke(device("d1", current: true), scope: scope("u1"))
        _ = await waitFor("the first sign-out") { self.spy.calls == 1 }
        _ = await waitFor("the first sign-out to finish") { !c.isSigningOut }

        service.devices = [device("d2", current: true)]
        await m.load(scope("u2", token: "t2"))
        await m.revoke(device("d2", current: true), scope: scope("u2", token: "t2"))
        _ = await waitFor("the second sign-out") { self.spy.calls == 2 }
    }

    /// A self-revoke that FAILED signs nothing out.
    ///
    /// The bearer is still valid — the server refused, so the credential is
    /// exactly where it was — and signing out on it would take away the only
    /// thing that can retry the revocation. The model already refuses to raise
    /// the signal; this is the claim from the observer's side, because the
    /// observer is now what turns a raised signal into a network call.
    func testAFailedSelfRevokeStartsNoSignOut() async {
        service.devices = [device("d1", current: true)]
        service.deleteDeviceError = AccountError.invalidCredentials
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope())

        await m.revoke(device("d1", current: true), scope: scope())
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(spy.calls, 0, "a refused revoke signed this device out anyway")
        XCTAssertFalse(c.isSigningOut)
        XCTAssertNotNil(m.error(forRow: "d1"), "the failure must stay on its row")
    }

    /// Revoking ANOTHER device raises no signal, so nothing here may fire: the
    /// app signing itself out because the user tidied up an old CLI login would
    /// be worse than the defect this type fixes.
    func testRevokingAnotherDeviceSignsNothingOut() async {
        service.devices = [device("d1", current: true), device("d2")]
        let m = makeModel()
        let c = makeCoordinator(m)
        await m.load(scope())

        await m.revoke(device("d2"), scope: scope())
        // Give the observer the same turn it would need to act, then check it
        // did not: a pass here must not merely be a race that ran too early.
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(spy.calls, 0, "revoking another device signed this one out")
        XCTAssertFalse(c.isSigningOut)
        XCTAssertEqual(m.devices.map(\.id), ["d1"])
    }

    /// The network call outlives the object that started it. The account view
    /// being torn down was the original defect; the shell being torn down —
    /// a scene going away — must not truncate a `logout` either, or the
    /// credential stays valid on the server with nothing left to revoke it.
    func testTheLogoutSurvivesTheCoordinatorBeingReleased() async {
        let m = makeModel()
        spy.isGated = true
        do {
            let c = makeCoordinator(m)
            c.signOut(scope: scope())
            _ = await waitFor("the logout to start") { self.spy.calls == 1 }
            _ = c
        }
        await spy.gate.release()
        // The call completes rather than being cancelled with the owner.
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(spy.calls, 1)
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
