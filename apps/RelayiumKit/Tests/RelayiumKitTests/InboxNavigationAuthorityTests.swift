import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit
@testable import RelayiumShareKit

/// **Which peer the user is working with, as ONE answer that outlives every
/// view.**
///
/// ## The defect these are written against
///
/// The owner reported that *Send content* stopped opening anything: after a
/// Cross-network pairing they switched to the Device Inbox, pressed the button
/// on the other device, and nothing happened — for the rest of the launch,
/// through cancelling and retrying the pairing, until the app was force-quit.
///
/// Nothing about the pairing was involved. There were two answers to "which
/// device's page is up": this model's, which is app-scoped and survives
/// anything short of relaunching, and a `@State` mirror on `DeviceInboxSurface`,
/// which the window's detail column rebuilds from nothing every time the user
/// switches destination. Coming back, the mirror was `nil` and this model still
/// named the device — and the page opened only from a change handler on the
/// model's selection. Pressing the button wrote the value that was already
/// there. An equal write is not a change, so the handler never ran, the mirror
/// stayed `nil`, and the button was dead. Force-quitting cleared the model,
/// which is why only a relaunch fixed it.
///
/// ## What is asserted here, and what is not
///
/// This suite owns the model half: one stored answer, a send target DERIVED
/// from it, and every way that answer may legally be opened, refused or
/// dropped. It cannot observe a SwiftUI view being torn down and rebuilt —
/// `InboxSurfaceGuardTests` pins the absence of the second answer in the source,
/// and `DeviceInboxUITests` drives the real destination switch in a running app.
/// The three together are the evidence; none of them is on its own.
@MainActor
final class InboxNavigationAuthorityTests: XCTestCase {
    private var root: URL!
    private var sender: FakeInboxSenderTransport!
    private var keys: InMemoryStoredLinkKeyStore!
    private var drafts: SharedDraftStore!
    private var store: PendingUploadStore!
    private var objects: FakeStoredObjectService!
    private var transport: StubTransport!

    private let deviceID = "DEVICE0123456789"
    private let otherDeviceID = "DEVICE9876543210"
    private let keyID = "KEY0123456789abcd"
    private var devicePublicKey = ""

    /// A peer with no device row at all: the read-only bucket that predates
    /// authenticated attribution, or a device removed from the account whose
    /// local history is still on this Mac. It has a page and can never have a
    /// composer, which is exactly the case one authority has to carry.
    private let legacyPeerID = "legacy-sender"

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("inbox-nav-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        store = PendingUploadStore(root: root.appendingPathComponent("PendingUploads"))
        keys = InMemoryStoredLinkKeyStore()
        drafts = SharedDraftStore(root: root.appendingPathComponent("SharedDrafts"))
        sender = FakeInboxSenderTransport()
        objects = FakeStoredObjectService()
        transport = StubTransport()
        devicePublicKey = InboxKeyMaterial.encode(try InboxKeyMaterial.generateKeyPair().publicKey)
        sender.deviceRows = [row(), row(id: otherDeviceID, name: "Kitchen")]
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    // MARK: - fixtures

    private func row(id: String? = nil, name: String = "Studio",
                     autoAccept: InboxAutoAccept = .auto, revoked: Bool = false,
                     canReceive: Bool = true) -> InboxDeviceRow {
        let key = InboxKey(id: keyID, algorithm: InboxProtocol.keyAlgorithm,
                           publicKey: devicePublicKey, generation: 4, createdAt: 10)
        return InboxDeviceRow(
            id: id ?? deviceID, name: name, kind: "mac", isCurrent: false,
            inbox: InboxView(presence: .online, lastHeartbeatAt: 10, presenceExpiresAt: 100,
                             heartbeatIntervalSeconds: 30, protocolVersion: 3,
                             capabilities: InboxProtocol.announcedCapabilities(presentingText: true),
                             receiveCapability: InboxCapability.receiveV3,
                             autoAccept: autoAccept, receiveDirReady: true,
                             revoked: revoked, canReceive: canReceive,
                             registeredAt: 10, key: key))
    }

    private final class NoSleep: InboxSleeping, @unchecked Sendable {
        func sleep(_ seconds: TimeInterval) async {}
        func wake() {}
    }

    private func ready(_ id: String) -> SessionState {
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

    private func waitUntil(_ what: String, timeout: Int = 600,
                           _ condition: @MainActor () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<timeout {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }

    private func signedIn(_ id: String = "acct-1")
        async -> (InboxSendModel, CurrentValueSubject<SessionState, Never>) {
        let session = CurrentValueSubject<SessionState, Never>(ready(id))
        let model = InboxSendModel(
            pending: PendingUploadSupport(store: store, keys: keys, drafts: drafts),
            uploader: CloudUploader(transport: transport),
            makeSender: { [sender] _ in sender! },
            objects: objects, sleeper: NoSleep(), pollSeconds: 0)
        model.observe(session)
        model.refreshTargets(token: "bearer-\(id)")
        await waitUntil("the device list") { model.directory == .loaded }
        return (model, session)
    }

    /// Re-read the device list and wait for the answer, the way the surface does
    /// when a device page appears.
    private func refresh(_ model: InboxSendModel, expecting: @escaping @MainActor () -> Bool)
        async {
        model.refreshTargets(token: "bearer-acct-1")
        await waitUntil("the re-read device list", expecting)
    }

    // MARK: - opening the device that is already open

    /// **The defect itself, at the layer that owns the answer.**
    ///
    /// Opening a device that is already the open one leaves it open. It is not
    /// refused, not toggled off, and — the part that mattered — it does not
    /// depend on the value having CHANGED for the page to be openable
    /// afterwards, because the page is derived from this rather than driven by a
    /// transition out of it.
    func testOpeningTheDeviceThatIsAlreadyOpenLeavesItOpen() async throws {
        let (model, _) = await signedIn()

        model.selectTarget(deviceID)
        XCTAssertEqual(model.focusedPeerID, deviceID)
        XCTAssertEqual(model.selectedTargetID, deviceID)

        // The press that used to do nothing, three times over.
        for _ in 0..<3 {
            model.selectTarget(deviceID)
            XCTAssertEqual(model.focusedPeerID, deviceID,
                           "re-opening the device that is already open closed it")
            XCTAssertEqual(model.selectedTargetID, deviceID,
                           "re-opening the device that is already open unaimed it")
        }

        // And through the navigation door, which takes any peer at all.
        model.focusPeer(deviceID)
        XCTAssertEqual(model.focusedPeerID, deviceID)
        XCTAssertEqual(model.selectedTargetID, deviceID)
    }

    /// **One answer serves a peer that can never be sent to.**
    ///
    /// This is what made a second, view-local answer look necessary: the send
    /// model refused to hold a legacy or removed peer, so the surface kept its
    /// own note of which page was up. It holds one now, and refuses to call it
    /// a target.
    func testAPeerThatCannotBeSentToStillOpensAndNeverBecomesTheTarget() async throws {
        let (model, _) = await signedIn()

        model.focusPeer(legacyPeerID)
        XCTAssertEqual(model.focusedPeerID, legacyPeerID,
                       "a read-only peer cannot be opened, so the page needs a second answer")
        XCTAssertNil(model.selectedTargetID,
                     "a peer with no device row became a send target")
        XCTAssertNil(model.selectedCandidate,
                     "a peer with no device row was offered a composer")
    }

    /// A blocked row may be OPENED — its history is real — and still may not be
    /// aimed at. The two doors keep their different admission rules.
    func testABlockedRowOpensWithoutEverBecomingTheTarget() async throws {
        let (model, _) = await signedIn()
        sender.deviceRows = [row(autoAccept: .off), row(id: otherDeviceID, name: "Kitchen")]
        await refresh(model) { model.candidates.first { $0.id == self.deviceID }?.isSendable == false }

        model.focusPeer(deviceID)
        XCTAssertEqual(model.focusedPeerID, deviceID)
        XCTAssertNil(model.selectedTargetID, "a blocked row became the send target")

        // The aiming door still refuses it outright, and — this is the part that
        // would silently aim at the wrong machine — refusing leaves the previous
        // focus alone rather than half-moving it.
        model.selectTarget(otherDeviceID)
        XCTAssertEqual(model.selectedTargetID, otherDeviceID)
        model.selectTarget(deviceID)
        XCTAssertEqual(model.selectedTargetID, otherDeviceID,
                       "a refused aim moved the target anyway")
        XCTAssertEqual(model.focusedPeerID, otherDeviceID,
                       "a refused aim moved the open page anyway")
    }

    // MARK: - the target goes stale under an open page

    /// **Revocation takes the composer away and leaves the page.**
    ///
    /// Two separate answers, and the split is the product decision: the user is
    /// still looking at that device and its local history is still real, so the
    /// page stays; nothing on it may send, so the target is gone. Nothing has to
    /// remember to clear anything — sendability is asked of the list being
    /// adopted.
    func testARevokedDeviceStopsBeingTheTargetWithoutClosingItsPage() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        XCTAssertEqual(model.selectedTargetID, deviceID)

        sender.deviceRows = [row(revoked: true), row(id: otherDeviceID, name: "Kitchen")]
        await refresh(model) { model.candidates.first { $0.id == self.deviceID }?.isSendable == false }

        XCTAssertNil(model.selectedTargetID,
                     "a revoked device is still a send target")
        XCTAssertNil(model.selectedCandidate,
                     "a revoked device is still offered a composer")
        XCTAssertEqual(model.focusedPeerID, deviceID,
                       "a revocation closed the page the user was reading")
    }

    /// A device that goes away entirely keeps its page open for its history.
    /// Whether that page has anything left to render is the surface's question,
    /// and it answers it by looking — not by this model having pre-emptively
    /// forgotten which peer was open.
    func testADeviceRemovedFromTheAccountLeavesItsPageOpenAndUnaimable() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)

        sender.deviceRows = [row(id: otherDeviceID, name: "Kitchen")]
        await refresh(model) { model.candidates.count == 1 }

        XCTAssertNil(model.selectedTargetID, "a device off the account is still a target")
        XCTAssertEqual(model.focusedPeerID, deviceID,
                       "a removed device took the open page with it")
    }

    /// **The other direction, and it is deliberate.** A device whose owner
    /// switches receiving back on becomes aimable again on the next read, with
    /// its page never having closed. Derivation is what makes that true; a
    /// stored selection cleared on the way down would have stayed cleared, and
    /// the user would be looking at a page whose composer never came back.
    ///
    /// Nothing unsafe follows from it: every send re-reads the target and the
    /// coordinator asks central again against a fresh device read.
    func testADeviceThatBecomesSendableAgainIsAimableAgain() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)

        sender.deviceRows = [row(canReceive: false), row(id: otherDeviceID, name: "Kitchen")]
        await refresh(model) { model.selectedTargetID == nil }

        sender.deviceRows = [row(), row(id: otherDeviceID, name: "Kitchen")]
        await refresh(model) { model.candidates.first { $0.id == self.deviceID }?.isSendable == true }
        XCTAssertEqual(model.selectedTargetID, deviceID,
                       "a device that can receive again is not aimable again")
    }

    // MARK: - the account

    /// Leaving an account closes the page, synchronously, on the same event that
    /// cancels its work. This is the one place the model closes a page on the
    /// user's behalf, and it must stay here rather than in a view: a surface
    /// that is not on screen would not run.
    func testAnAccountChangeClosesTheOpenPage() async throws {
        let (model, session) = await signedIn()
        model.selectTarget(deviceID)
        XCTAssertEqual(model.focusedPeerID, deviceID)

        session.send(ready("acct-2"))
        XCTAssertNil(model.focusedPeerID,
                     "one account's open device page survived into another account")
        XCTAssertNil(model.selectedTargetID)
        XCTAssertNil(model.selectedCandidate)
    }

    /// Closing the page closes exactly one thing, and Back is the only ordinary
    /// way it happens.
    func testClosingThePageClearsTheOneAnswer() async throws {
        let (model, _) = await signedIn()
        model.selectTarget(deviceID)
        model.focusPeer(nil)
        XCTAssertNil(model.focusedPeerID)
        XCTAssertNil(model.selectedTargetID)

        model.selectTarget(deviceID)
        model.selectTarget(nil)
        XCTAssertNil(model.focusedPeerID, "the aiming door cannot close the page")
    }
}
