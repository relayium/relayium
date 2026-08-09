import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Off, Ask every time, Automatically — and the two rules that keep those three
/// answers honest.
///
///  1. **Default off, by every route.** A missing key, a fresh install, a cleared
///     defaults domain and a value this build does not recognise all mean `off`.
///     There is no spelling of this store's state that turns unattended writes on
///     by omission.
///  2. **A folder is not consent.** Both non-`off` answers are refused without a
///     chosen folder, and choosing a folder never moves the answer.
final class InboxReceivePolicyTests: XCTestCase {

    private let account = try! InboxAccountID("accountpolicy01")
    private let other = try! InboxAccountID("accountpolicy02")

    private func directory() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("relayium-policy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func defaultsSuite() throws -> UserDefaults {
        let name = "com.relayium.tests.inboxpolicy.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    // MARK: - default off

    func testAnUntouchedStoreIsOffForEveryAccount() throws {
        let defaults = try defaultsSuite()
        let store = UserDefaultsInboxFolderStore(defaults: defaults)
        XCTAssertEqual(store.receivePolicy(account: account), .off)
        XCTAssertFalse(store.automaticReceive(account: account))
        XCTAssertEqual(InMemoryInboxFolderStore().receivePolicy(account: account), .off)
    }

    /// A defaults domain written by a newer build — or by hand — must not be able
    /// to turn unattended writes on through a value this build cannot interpret.
    func testAnUnrecognisedStoredPolicyReadsAsOff() throws {
        let defaults = try defaultsSuite()
        defaults.set("everything", // nonlocalized: a policy token no build defines
                     forKey: UserDefaultsInboxFolderStore.policyKey(account))
        let store = UserDefaultsInboxFolderStore(defaults: defaults)
        XCTAssertEqual(store.receivePolicy(account: account), .off)
        XCTAssertFalse(store.automaticReceive(account: account))
    }

    /// A device that had automatic receive on before the policy existed keeps it,
    /// rather than going quiet after an update — and the superseded key is
    /// cleared as soon as the policy is written, so the two can never disagree.
    func testThePhase2ABooleanMigratesOnceAndIsThenSuperseded() throws {
        let defaults = try defaultsSuite()
        defaults.set(true, forKey: UserDefaultsInboxFolderStore.automaticKey(account))
        let store = UserDefaultsInboxFolderStore(defaults: defaults)
        XCTAssertEqual(store.receivePolicy(account: account), .auto)

        store.setReceivePolicy(.ask, account: account)
        XCTAssertEqual(store.receivePolicy(account: account), .ask)
        XCTAssertNil(defaults.object(forKey: UserDefaultsInboxFolderStore.automaticKey(account)),
                     "the migrated boolean survived the policy that superseded it")
    }

    func testAPolicyIsScopedToItsOwnAccount() throws {
        let defaults = try defaultsSuite()
        let store = UserDefaultsInboxFolderStore(defaults: defaults)
        store.setReceivePolicy(.auto, account: account)
        XCTAssertEqual(store.receivePolicy(account: other), .off,
                       "one account's decision authorised writes for another")
    }

    func testAPendingStopAnnouncementIsDurableAndAccountScoped() throws {
        let defaults = try defaultsSuite()
        let first = UserDefaultsInboxFolderStore(defaults: defaults)
        first.setStopAnnouncementPending(true, account: account)

        let afterRelaunch = UserDefaultsInboxFolderStore(defaults: defaults)
        XCTAssertTrue(afterRelaunch.stopAnnouncementPending(account: account))
        XCTAssertFalse(afterRelaunch.stopAnnouncementPending(account: other),
                       "one account inherited another account's pending stop")
        afterRelaunch.setStopAnnouncementPending(false, account: account)
        XCTAssertFalse(first.stopAnnouncementPending(account: account))
    }

    // MARK: - the folder is a separate consent

    func testChoosingAFolderLeavesThePolicyExactlyWhereItWas() throws {
        let root = try directory()
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: PolicyBookmarking(url: root))
        try folder.chooseFolder(root, account: account)
        XCTAssertEqual(folder.receivePolicy(account: account), .off)
        XCTAssertFalse(folder.isAutomaticReceiveEnabled(account: account))
        XCTAssertTrue(folder.hasFolder(account: account))
    }

    /// `ask` is refused without a folder for the same reason `auto` is, and it is
    /// the less obvious half: announcing `ask` invites a sender to queue work,
    /// and there would be nowhere to put it once the user said yes.
    func testBothNonOffAnswersAreRefusedWithoutAFolder() throws {
        let folder = InboxReceiveFolder(store: InMemoryInboxFolderStore(),
                                        bookmarking: PolicyBookmarking(url: nil))
        for policy in [InboxAutoAccept.ask, .auto] {
            XCTAssertThrowsError(try folder.setReceivePolicy(policy, account: account)) { error in
                XCTAssertEqual(error as? InboxFolderError, .noFolderChosen)
            }
            XCTAssertEqual(folder.receivePolicy(account: account), .off)
        }
        // Off is always allowed: turning it off cannot depend on having a folder.
        XCTAssertNoThrow(try folder.setReceivePolicy(.off, account: account))
    }

    func testForgettingTheFolderAlsoTurnsReceivingOff() throws {
        let root = try directory()
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: PolicyBookmarking(url: root))
        try folder.chooseFolder(root, account: account)
        try folder.setReceivePolicy(.auto, account: account)

        folder.forget(account: account)
        XCTAssertFalse(folder.hasFolder(account: account))
        XCTAssertEqual(folder.receivePolicy(account: account), .off,
                       "a stored yes was left waiting for whatever folder is chosen next")
    }

    /// The Phase 2A spelling still means what it meant, and it means it in terms
    /// of the policy rather than beside it.
    func testTheBooleanSpellingIsADerivedReadingOfThePolicy() throws {
        let store = InMemoryInboxFolderStore()
        store.setReceivePolicy(.ask, account: account)
        XCTAssertFalse(store.automaticReceive(account: account),
                       "`ask` must never read as unattended receive")
        store.setAutomaticReceive(true, account: account)
        XCTAssertEqual(store.receivePolicy(account: account), .auto)
        store.setAutomaticReceive(false, account: account)
        XCTAssertEqual(store.receivePolicy(account: account), .off)
    }

    /// The engine announces the answer itself, including the one a boolean
    /// cannot hold.
    func testTheEngineAnnouncesAllThreeAnswers() throws {
        let root = try directory()
        let store = InMemoryInboxFolderStore()
        let folder = InboxReceiveFolder(store: store, bookmarking: PolicyBookmarking(url: root))
        try folder.chooseFolder(root, account: account)
        let engine = InboxReceiveEngine(transport: FakeInboxTransport(),
                                        keys: InMemoryInboxDeviceKeyStore(),
                                        journals: InboxJournalStore(directory: root),
                                        folder: folder, account: account)
        for policy in [InboxAutoAccept.off, .ask, .auto] {
            try folder.setReceivePolicy(policy, account: account)
            XCTAssertEqual(engine.announcedPolicy, policy)
        }
    }
}

private struct PolicyBookmarking: InboxFolderBookmarking {
    let url: URL?
    func bookmark(for url: URL) throws -> Data { Data(url.path.utf8) }
    func resolve(_ data: Data) throws -> (url: URL, isStale: Bool) {
        guard let url else { throw InboxFolderError.bookmarkFailed }
        return (url, false)
    }
    func startAccess(to url: URL) -> Bool { true }
    func stopAccess(to url: URL) {}
}
