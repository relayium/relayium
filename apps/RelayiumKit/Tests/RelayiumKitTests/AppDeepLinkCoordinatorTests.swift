import Combine
import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

// MARK: - stubs

/// Mints on demand so a realtime model can be driven into a BUSY state — which
/// is the only interesting precondition here — and back out of it.
private final class StubPair: PairCodeClient, @unchecked Sendable {
    var result = MintedCode(code: "483920", expiresAt: 1800000000)
    func mint(token: String) async throws -> MintedCode { result }
}

private final class StubICE: ICEConfigClient, @unchecked Sendable {
    func fetch(code: String) async throws -> ICEConfig {
        ICEConfig(iceServers: [ICEServerConfig(urls: ["stun:s:3478"])])
    }
}

private final class StubConnection: RealtimePeerConnection, @unchecked Sendable {
    var onSAS: ((String) -> Void)?
    var onOpen: (() -> Void)?
    var onManifest: (([FileMeta]) -> Void)?
    var onFileChunk: (([UInt8]) -> Void)?
    var onProgress: ((Int) -> Void)?
    var onDone: ((Bool) -> Void)?
    var onText: ((String, Int) -> Void)?
    var onControl: ((RealtimeControl) -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?

    func start() {}
    func send(sources: [PlaintextSource], metas: [FileMeta]) {}
    func accept() {}
    func reject() {}
    func complete() {}
    func confirmTextSAS() {}
    func acceptText() {}
    func rejectText() {}
    func sendText(_ body: String, completion: @escaping (Error?) -> Void) { completion(nil) }
    var textBufferedAmount: UInt64 { 0 }
    func close() {}
}

/// What a Universal Link is allowed to do to a running app.
///
/// Every assertion is against REAL models. The interesting failures here are all
/// "a link arrived at the wrong moment", and a fake that reports busy on command
/// would prove that the coordinator asks a question — not that the answer
/// matches what a transfer actually looks like. So a download is driven through
/// a stubbed URL session and a realtime session through a stubbed mint, and the
/// preconditions are the states those models really reach.
@MainActor
final class AppDeepLinkCoordinatorTests: XCTestCase {

    // MARK: - fixtures

    private let downloadURL = URL(string: "https://relayium.com/d/abc123#k=KEYPART")!
    private let otherDownloadURL = URL(string: "https://relayium.com/d/zzz999#k=OTHERKEY")!

    private func realtimeURL(_ code: String) -> URL {
        URL(string: "https://relayium.com/cross-network#c=\(code)")!
    }

    private func typedRealtimeURL(_ code: String, mode: TransferMode) -> URL {
        productionPairingJoinURL(code: code, mode: mode)!
    }

    private var codelessRealtimeURL: URL {
        URL(string: "https://relayium.com/cross-network")!
    }

    override func tearDown() {
        StubURLProtocol.router = nil
        StubURLProtocol.stub = nil
        super.tearDown()
    }

    /// How many requests actually left for a stored object, by link id.
    ///
    /// This is what "the link was applied, exactly once" is asserted against for
    /// a download. The coordinator keeps NO record of the links it has applied —
    /// a `/d/<id>#k=<key>` link is the file's decryption key, so a list of them
    /// would be a list of keys held for the life of the process — so the claim
    /// is made where the effect is: the field the link filled, and the one
    /// resolve it caused. Ids only; the `#k=` fragment never leaves the device
    /// and is not what is being counted here.
    private func requests(forLinkID id: String) -> Int {
        StubURLProtocol.observed.filter { $0.url?.path.contains(id) ?? false }.count
    }

    /// A download model whose every request answers `status`. 404 is the default
    /// because most cases here only need the model to LEAVE `.resolving`, and a
    /// terminal failure is the shortest honest way there.
    private func makeDownload(status: Int = 404) -> CloudDownloadModel {
        StubURLProtocol.router = { _ in .init(status: status, body: Data()) }
        return CloudDownloadModel(client: CloudClient(
            baseURL: URL(string: "https://example.invalid")!,
            session: StubURLProtocol.session()))
    }

    private func makeRealtime() -> RealtimeSessionModel {
        let connection = StubConnection()
        return RealtimeSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                    makeConnection: { _, _, _ in connection })
    }

    private func makeRealtimeText() -> RealtimeTextSessionModel {
        let connection = StubConnection()
        return RealtimeTextSessionModel(pairClient: StubPair(), iceClient: StubICE(),
                                        makeConnection: { _, _, _ in connection })
    }

    private struct Rig {
        let navigation: AppNavigationModel
        let download: CloudDownloadModel
        let realtime: RealtimeSessionModel
        let realtimeText: RealtimeTextSessionModel
        let modes: DirectModeSelection
        let presence: TransferPresence
        let coordinator: AppDeepLinkCoordinator
    }

    private func makeRig(downloadStatus: Int = 404) -> Rig {
        let navigation = AppNavigationModel(selection: .nearby)
        let download = makeDownload(status: downloadStatus)
        let realtime = makeRealtime()
        let realtimeText = makeRealtimeText()
        let modes = DirectModeSelection()
        let presence = TransferPresence()
        return Rig(navigation: navigation, download: download,
                   realtime: realtime, realtimeText: realtimeText,
                   modes: modes, presence: presence,
                   coordinator: AppDeepLinkCoordinator(
                    navigation: navigation, download: download,
                    realtime: realtime, realtimeText: realtimeText,
                    presence: presence,
                    selectRealtimeMode: { mode in
                        modes.select(mode, file: realtime.state, text: realtimeText.state)
                    }))
    }

    private func link(_ url: URL) -> AppDeepLink {
        // Through the production parser, never hand-built: a test that
        // constructed `.download(url)` itself would keep passing after the
        // parser stopped accepting the URL it names.
        guard let parsed = parseAppDeepLink(url) else {
            XCTFail("the parser refuses \(url), so this fixture proves nothing")
            return .realtime(code: nil)
        }
        return parsed
    }

    /// A real (stubbed) URL round trip settles on another queue, so the test has
    /// to wait for the state rather than for the actor to drain.
    private func waitFor(_ what: String, _ ready: @MainActor () -> Bool,
                         seconds: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if ready() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("timed out waiting for \(what)")
    }

    /// Let the main actor run the deferred `Task` the busy watcher schedules.
    private func settleMainActor() async {
        for _ in 0..<8 { await Task.yield() }
    }

    // MARK: - the happy path, cold and warm

    /// A download link selects Receive, fills the field and resolves — and does
    /// **not** save anything. Resolution reads encrypted metadata and decrypts
    /// the manifest; writing files is a separate, explicit action.
    func testADownloadLinkSelectsReceiveFillsTheFieldAndOnlyResolves() async {
        let rig = makeRig()
        StubURLProtocol.reset()
        rig.coordinator.deliver(link(downloadURL))

        XCTAssertEqual(rig.navigation.selection, .storedReceive)
        XCTAssertEqual(rig.navigation.selectionWrites, 1)
        XCTAssertEqual(rig.download.linkText, downloadURL.absoluteString)
        XCTAssertEqual(rig.download.state, .resolving,
                       "the link must resolve its metadata on arrival")

        await waitFor("the stubbed 404 to land", { !rig.download.isBusy })
        await settleMainActor()
        // Whatever the server said, nothing was written and no destination was
        // ever chosen: a link cannot start a download.
        XCTAssertNil(rig.download.received)
        XCTAssertNil(rig.download.receivedContainer)
        if case .done = rig.download.state { XCTFail("a link downloaded on its own") }
        // One resolve, and it stayed one after the model went idle: the watcher
        // that exists for a link arriving mid-transfer must not re-apply a link
        // that has already landed.
        XCTAssertEqual(requests(forLinkID: "abc123"), 1,
                       "the link resolved more than once")
    }

    /// Account's Open action is an in-app source of the same capability link.
    /// It must pass through the production parser and the coordinator rather
    /// than writing the download model or changing tabs independently.
    func testAStoredAccountLinkUsesTheSameValidatedDownloadRoute() async {
        let rig = makeRig()
        StubURLProtocol.reset()

        XCTAssertTrue(rig.coordinator.deliverStoredLink(downloadURL.absoluteString))
        XCTAssertEqual(rig.navigation.selection, .storedReceive)
        XCTAssertEqual(rig.navigation.selectionWrites, 1)
        XCTAssertEqual(rig.download.linkText, downloadURL.absoluteString)
        XCTAssertEqual(rig.download.state, .resolving)

        await waitFor("the account link resolve to finish", { !rig.download.isBusy })
        XCTAssertEqual(requests(forLinkID: "abc123"), 1)
        XCTAssertNil(rig.download.received,
                     "opening an Account row downloaded without Save")
    }

    func testAStoredAccountLinkRefusesAnythingOutsideTheDownloadTrustBoundary() {
        let rig = makeRig()
        for raw in ["not a link", "https://evil.example/d/abc123#k=KEYPART",
                    "https://relayium.com/cross-network#c=483920"] {
            XCTAssertFalse(rig.coordinator.deliverStoredLink(raw), raw)
        }
        XCTAssertEqual(rig.navigation.selection, .nearby)
        XCTAssertEqual(rig.navigation.selectionWrites, 0)
        XCTAssertTrue(rig.download.linkText.isEmpty)
        XCTAssertEqual(rig.download.state, .idle)
    }

    /// A realtime link selects Direct and prefills BOTH models, because the URL
    /// does not say whether the sender chose files or text. Prefilling one would
    /// make the feature work for half the codes it can carry.
    func testARealtimeLinkSelectsDirectAndPrefillsBothModelsWithoutJoining() {
        let rig = makeRig()
        rig.coordinator.deliver(link(realtimeURL("483920")))

        XCTAssertEqual(rig.navigation.selection, .pairingCode)
        XCTAssertEqual(rig.navigation.selectionWrites, 1)
        XCTAssertEqual(rig.realtime.joinCode, "483920")
        XCTAssertEqual(rig.realtimeText.joinCode, "483920")
        // Prefilled and joinable — but not joined. Both models are still idle,
        // which is the whole claim: the tap belongs to the user.
        XCTAssertTrue(rig.realtime.canJoin)
        XCTAssertTrue(rig.realtimeText.canJoin)
        XCTAssertEqual(rig.realtime.state, .idle)
        XCTAssertEqual(rig.realtimeText.state, .idle)
        XCTAssertFalse(rig.realtime.isBusy)
        XCTAssertFalse(rig.realtimeText.isBusy)
    }

    /// A new first-party handoff carries the sender's choice, so opening a text
    /// QR/link must not strand the receiver on Files. It still only prefills:
    /// the receiving device owns the final Join tap.
    func testATypedRealtimeLinkSelectsItsModeAndPrefillsWithoutJoining() {
        let rig = makeRig()
        XCTAssertEqual(rig.modes.mode, .files)

        rig.coordinator.deliver(link(typedRealtimeURL("483920", mode: .text)))

        XCTAssertEqual(rig.navigation.selection, .pairingCode)
        XCTAssertEqual(rig.navigation.selectionWrites, 1)
        XCTAssertEqual(rig.modes.mode, .text)
        XCTAssertEqual(rig.realtime.joinCode, "483920")
        XCTAssertEqual(rig.realtimeText.joinCode, "483920")
        XCTAssertEqual(rig.realtime.state, .idle)
        XCTAssertEqual(rig.realtimeText.state, .idle)
    }

    /// A code is a string, not an integer. `004291` and `000000` are ordinary
    /// codes, and an Int round-trip anywhere on this path would silently destroy
    /// a tenth of the code space.
    func testALeadingZeroCodeSurvivesTheWholePath() {
        for code in ["004291", "000000", "012345"] {
            let rig = makeRig()
            rig.coordinator.deliver(link(realtimeURL(code)))
            XCTAssertEqual(rig.realtime.joinCode, code)
            XCTAssertEqual(rig.realtimeText.joinCode, code)
            XCTAssertTrue(rig.realtime.canJoin, code)
        }
    }

    /// A code-less `/cross-network` link is a request to look at the Direct
    /// surface. It must not clear a code the user is part-way through typing —
    /// which is the exact shape of "I opened the link on the wrong device, let
    /// me type the code here instead".
    func testACodelessRealtimeLinkSelectsDirectWithoutClearingATypedCode() {
        let rig = makeRig()
        rig.realtime.updateJoinCode("4839")
        rig.realtimeText.updateJoinCode("4839")

        rig.coordinator.deliver(link(codelessRealtimeURL))

        XCTAssertEqual(rig.navigation.selection, .pairingCode)
        XCTAssertEqual(rig.navigation.selectionWrites, 1)
        XCTAssertEqual(rig.realtime.joinCode, "4839", "a code-less link wiped a typed code")
        XCTAssertEqual(rig.realtimeText.joinCode, "4839")
        XCTAssertNil(rig.coordinator.waiting,
                     "a link with nothing to write must not queue itself forever")
    }

    /// The cold-launch shape: the router holds the link before anything
    /// subscribes, and `Published` replays it to the shell when it appears. The
    /// result has to be identical to the warm case, and applied exactly once.
    func testAColdLaunchReplayDeliversTheLinkExactlyOnce() {
        let rig = makeRig()
        let router = AppDeepLinkRouter()
        XCTAssertTrue(router.open(realtimeURL("483920")))

        // The shell subscribes afterwards — the cold-launch order.
        var seen: [AppDeepLink] = []
        let subscription = router.$pending.compactMap { $0 }.sink { link in
            seen.append(link)
            rig.coordinator.deliver(link)
        }
        defer { subscription.cancel() }

        XCTAssertEqual(seen, [.realtime(code: "483920")])
        XCTAssertEqual(rig.navigation.selectionWrites, 1)
        XCTAssertEqual(rig.realtime.joinCode, "483920")
        XCTAssertEqual(rig.realtimeText.joinCode, "483920")
        XCTAssertNil(rig.coordinator.waiting)
    }

    // MARK: - what the coordinator is allowed to keep

    /// **A download link is a decryption key**, so the coordinator holds one
    /// only while it has to and holds nothing once it has applied it.
    ///
    /// `/d/<id>#k=<key>` carries the key the server never sees; the app's whole
    /// promise rests on that fragment. A list of applied links would keep every
    /// key of every file this app has opened alive for the life of the process,
    /// reachable from anything holding the coordinator and present in any memory
    /// capture — to answer a question tests can answer from the models instead.
    ///
    /// Reflection rather than a named property, because the point is that NO
    /// property may hold it: an `applied` array, a `last` link, a "seen" set for
    /// de-duplication all fail this equally. Model references dump as their type
    /// name, not their contents, so `CloudDownloadModel.linkText` — the field
    /// the user is looking at — is correctly not what this reads.
    func testTheCoordinatorKeepsNoLinkOnceItHasAppliedIt() async {
        let rig = makeRig()
        rig.download.linkText = otherDownloadURL.absoluteString
        rig.download.resolve()
        rig.coordinator.deliver(link(downloadURL))

        // While it waits, the ONE retained link is the key — by design, and it
        // is the reason application can be deferred at all.
        XCTAssertEqual(rig.coordinator.waiting, .download(downloadURL))
        XCTAssertTrue(retainedText(of: rig.coordinator).contains("KEYPART"),
                      "reflection cannot see the retained link, so the check below "
                      + "would pass for a coordinator that kept every one of them")

        await waitFor("the running resolve to end", { !rig.download.isBusy })
        await waitFor("the retained link to be applied", { rig.coordinator.waiting == nil })
        XCTAssertEqual(rig.download.linkText, downloadURL.absoluteString,
                       "the link never applied, so this proves nothing yet")
        for secret in ["KEYPART", "abc123", "OTHERKEY", "zzz999"] {
            XCTAssertFalse(retainedText(of: rig.coordinator).contains(secret),
                           "the coordinator kept an applied link: \(secret)")
        }
    }

    /// Everything the coordinator's own stored properties hold, as text.
    ///
    /// One level deep on purpose: a class reference renders as its type name, so
    /// this sees what the COORDINATOR keeps and not what the models it points at
    /// keep. Value-typed storage — an array of links, an optional link, a
    /// `Published` wrapper around one — renders its contents.
    private func retainedText(of coordinator: AppDeepLinkCoordinator) -> String {
        Mirror(reflecting: coordinator).children
            .map { "\($0.label ?? ""): \(String(describing: $0.value))" }
            .joined(separator: "\n")
    }

    // MARK: - a link must not replace work in flight

    /// A stored download that is RESOLVING owns the field the link would
    /// overwrite. Replacing it would abandon the resolve mid-flight and point
    /// the model at a different object.
    func testALinkDoesNotReplaceAResolveThatIsStillRunning() async {
        let rig = makeRig()
        StubURLProtocol.reset()
        rig.download.linkText = otherDownloadURL.absoluteString
        rig.download.resolve()
        XCTAssertTrue(rig.download.isBusy)

        rig.coordinator.deliver(link(downloadURL))

        // Navigation still happened — the user tapped a link and must see that
        // it arrived — but nothing was written.
        XCTAssertEqual(rig.navigation.selection, .storedReceive)
        XCTAssertEqual(rig.download.linkText, otherDownloadURL.absoluteString,
                       "a link replaced a resolve that was still running")
        XCTAssertEqual(rig.coordinator.waiting, .download(downloadURL))
        XCTAssertEqual(requests(forLinkID: "abc123"), 0,
                       "the waiting link resolved while another resolve was running")

        // …and lands on its own once the model is free, with NO second
        // navigation write.
        await waitFor("the running resolve to end", { !rig.download.isBusy })
        // Applied AND finished: `!isBusy` alone is also true in the window
        // before the deferred application has run, so the field is part of the
        // condition rather than of the assertion that follows it.
        await waitFor("the retained link to be applied and to resolve", {
            rig.download.linkText == downloadURL.absoluteString && !rig.download.isBusy
        })
        XCTAssertEqual(rig.download.linkText, downloadURL.absoluteString,
                       "the retained link was never applied")
        // Applied once, proved by the side effect rather than by a record the
        // coordinator keeps: its resolve went out exactly one time, and the
        // resolve it was waiting behind was not repeated.
        XCTAssertEqual(requests(forLinkID: "abc123"), 1,
                       "the retained link was applied more than once")
        XCTAssertEqual(requests(forLinkID: "zzz999"), 1,
                       "the resolve the link waited for was restarted")
        XCTAssertNil(rig.coordinator.waiting)
        XCTAssertEqual(rig.navigation.selectionWrites, 1,
                       "deferred application navigated a second time")
    }

    /// The FILE half of Direct is mid-session. The code it is running on must
    /// not be swapped under it, even though the text half is idle — the two
    /// fields have to stay in step or the picker disagrees with itself.
    func testALinkDoesNotReplaceALiveFileSession() async {
        let rig = makeRig()
        await rig.realtime.mintCode(token: "t")
        XCTAssertTrue(rig.realtime.isBusy)
        XCTAssertFalse(rig.realtimeText.isBusy)
        rig.realtime.updateJoinCode("111111")
        rig.realtimeText.updateJoinCode("111111")

        rig.coordinator.deliver(link(realtimeURL("483920")))

        XCTAssertEqual(rig.navigation.selection, .pairingCode)
        XCTAssertEqual(rig.realtime.joinCode, "111111", "a link overwrote a live session's code")
        XCTAssertEqual(rig.realtimeText.joinCode, "111111",
                       "the two halves were left disagreeing about the code")
        XCTAssertEqual(rig.coordinator.waiting, .realtime(code: "483920"))
        XCTAssertTrue(rig.realtime.isBusy, "the live session was cancelled by a link")

        rig.realtime.cancel()
        await settleMainActor()
        XCTAssertEqual(rig.realtime.joinCode, "483920")
        XCTAssertEqual(rig.realtimeText.joinCode, "483920")
        XCTAssertNil(rig.coordinator.waiting)
        XCTAssertEqual(rig.navigation.selectionWrites, 1)

        // Applied once. The code the user types next survives every further
        // publish the now-idle models make, which is what a second application
        // would overwrite.
        rig.realtime.updateJoinCode("777777")
        rig.realtimeText.updateJoinCode("777777")
        await settleMainActor()
        XCTAssertEqual(rig.realtime.joinCode, "777777",
                       "the link was applied a second time")
        XCTAssertEqual(rig.realtimeText.joinCode, "777777")
    }

    /// Mode and code are one product intent. While either direct model owns a
    /// session, neither half may land early; after it ends they apply together.
    func testATypedLinkDefersItsModeAndCodeTogetherBehindALiveSession() async {
        let rig = makeRig()
        await rig.realtime.mintCode(token: "t")
        rig.realtime.updateJoinCode("111111")
        rig.realtimeText.updateJoinCode("111111")

        let typed = link(typedRealtimeURL("483920", mode: .text))
        rig.coordinator.deliver(typed)

        XCTAssertEqual(rig.modes.mode, .files, "the mode moved before the live session ended")
        XCTAssertEqual(rig.realtime.joinCode, "111111")
        XCTAssertEqual(rig.realtimeText.joinCode, "111111")
        XCTAssertEqual(rig.coordinator.waiting, typed)

        rig.realtime.cancel()
        await settleMainActor()

        XCTAssertEqual(rig.modes.mode, .text)
        XCTAssertEqual(rig.realtime.joinCode, "483920")
        XCTAssertEqual(rig.realtimeText.joinCode, "483920")
        XCTAssertNil(rig.coordinator.waiting)
        XCTAssertEqual(rig.navigation.selectionWrites, 1)
    }

    /// A surface claim happens synchronously before the task that moves either
    /// model out of idle. That gap is already a session: a link must wait for
    /// ownership to be released rather than overwriting the intent about to run.
    func testEveryPairingLinkWaitsBehindAClaimThatPrecedesModelBusyState() async {
        let cases: [(URL, TransferMode)] = [
            (realtimeURL("483920"), .files),
            (typedRealtimeURL("483920", mode: .text), .text),
        ]
        for (url, appliedMode) in cases {
            let rig = makeRig()
            XCTAssertTrue(rig.presence.claim(.nearby))
            XCTAssertEqual(rig.realtime.state, .idle)
            XCTAssertEqual(rig.realtimeText.state, .idle)

            let pending = link(url)
            rig.coordinator.deliver(pending)

            XCTAssertEqual(rig.modes.mode, .files)
            XCTAssertEqual(rig.realtime.joinCode, "")
            XCTAssertEqual(rig.realtimeText.joinCode, "")
            XCTAssertEqual(rig.coordinator.waiting, pending)

            rig.presence.release(.nearby)
            await settleMainActor()

            XCTAssertEqual(rig.modes.mode, appliedMode)
            XCTAssertEqual(rig.realtime.joinCode, "483920")
            XCTAssertEqual(rig.realtimeText.joinCode, "483920")
            XCTAssertNil(rig.coordinator.waiting)
            XCTAssertEqual(rig.navigation.selectionWrites, 1)
        }
    }

    /// The same claim from the other side: the TEXT half is mid-session and the
    /// file half is idle. Both directions matter because a legacy link carries
    /// no hint of which one the user is in.
    func testALinkDoesNotReplaceALiveTextSession() async {
        let rig = makeRig()
        await rig.realtimeText.mintCode(token: "t")
        XCTAssertTrue(rig.realtimeText.isBusy)
        XCTAssertFalse(rig.realtime.isBusy)

        rig.coordinator.deliver(link(realtimeURL("483920")))

        XCTAssertEqual(rig.realtime.joinCode, "")
        XCTAssertEqual(rig.realtimeText.joinCode, "")
        XCTAssertEqual(rig.coordinator.waiting, .realtime(code: "483920"))

        rig.realtimeText.end()
        await settleMainActor()
        XCTAssertEqual(rig.realtime.joinCode, "483920")
        XCTAssertEqual(rig.realtimeText.joinCode, "483920")
        XCTAssertEqual(rig.navigation.selectionWrites, 1)
    }

    /// A live session must not be able to hold a code-less link hostage either:
    /// it writes nothing, so there is nothing to wait for. Queuing it would mean
    /// an unrelated link applying itself minutes later.
    func testACodelessLinkIsNeverQueuedBehindALiveSession() async {
        let rig = makeRig()
        await rig.realtime.mintCode(token: "t")
        XCTAssertTrue(rig.realtime.isBusy)

        rig.coordinator.deliver(link(codelessRealtimeURL))

        XCTAssertNil(rig.coordinator.waiting)
        XCTAssertTrue(rig.realtime.isBusy, "a code-less link ended a live session")
        XCTAssertEqual(rig.realtime.joinCode, "", "a code-less link wrote a code")
    }

    // MARK: - the later link wins, and the later navigation stays

    /// A second link arriving during the wait replaces the first. Two links are
    /// two things the user asked for, and the older one is the one they have
    /// already moved on from — applying it later would open a transfer they
    /// abandoned.
    func testANewerWaitingLinkSupersedesAnOlderOne() async {
        let rig = makeRig()
        await rig.realtime.mintCode(token: "t")

        rig.coordinator.deliver(link(realtimeURL("111111")))
        XCTAssertEqual(rig.coordinator.waiting, .realtime(code: "111111"))
        rig.coordinator.deliver(link(realtimeURL("222222")))
        XCTAssertEqual(rig.coordinator.waiting, .realtime(code: "222222"))

        rig.realtime.cancel()
        await settleMainActor()
        XCTAssertEqual(rig.realtime.joinCode, "222222",
                       "the superseded link was applied instead")
        XCTAssertEqual(rig.realtimeText.joinCode, "222222")
        XCTAssertNil(rig.coordinator.waiting,
                     "the superseded link was left queued behind the newer one")
        XCTAssertEqual(rig.navigation.selectionWrites, 2,
                       "each delivery navigates once, and only on delivery")
    }

    /// **The stolen-navigation case.** A link waits behind a live session; while
    /// it waits, an unsolicited nearby session takes the screen. When the wait
    /// ends, the field is filled — and the user stays on Nearby. A second
    /// selection here would yank the screen away from a session that is running,
    /// minutes after anyone asked for it.
    func testDeferredApplicationDoesNotStealALaterNavigation() async {
        let rig = makeRig()
        await rig.realtime.mintCode(token: "t")
        rig.coordinator.deliver(link(realtimeURL("483920")))
        XCTAssertEqual(rig.navigation.selection, .pairingCode)

        // Something else navigates — an inbound session, or the user.
        rig.navigation.select(.nearby)
        XCTAssertEqual(rig.navigation.selectionWrites, 2)

        rig.realtime.cancel()
        await settleMainActor()

        XCTAssertEqual(rig.realtime.joinCode, "483920", "the retained link never applied")
        XCTAssertEqual(rig.navigation.selection, .nearby,
                       "deferred application stole the selection back")
        XCTAssertEqual(rig.navigation.selectionWrites, 2,
                       "deferred application wrote the selection a second time")
    }

    /// A link that CAN be applied immediately drops one that is still waiting.
    /// Otherwise the older one would land later and overwrite the newer one.
    func testAnImmediatelyAppliedLinkDropsTheWaitingOne() async {
        let rig = makeRig()
        await rig.realtime.mintCode(token: "t")
        rig.coordinator.deliver(link(realtimeURL("111111")))
        XCTAssertEqual(rig.coordinator.waiting, .realtime(code: "111111"))

        // A download link is unaffected by a live realtime session, so it
        // applies at once — and the realtime one it displaces must not come
        // back when the session ends.
        rig.coordinator.deliver(link(downloadURL))
        XCTAssertNil(rig.coordinator.waiting)
        XCTAssertEqual(rig.download.linkText, downloadURL.absoluteString)

        rig.realtime.cancel()
        await settleMainActor()
        XCTAssertEqual(rig.realtime.joinCode, "", "a dropped link applied itself later")
        XCTAssertEqual(rig.realtimeText.joinCode, "")
        XCTAssertEqual(rig.download.linkText, downloadURL.absoluteString)
    }

    /// `applyIfSafe` re-reads what is waiting NOW rather than acting on a link
    /// some earlier turn captured. That is what makes the watcher's deferred
    /// `Task` harmless when a newer link has landed inside the gap.
    func testApplyIfSafeIsAOneShotThatCannotResurrectAnAppliedLink() async {
        let rig = makeRig()
        await rig.realtime.mintCode(token: "t")
        rig.coordinator.deliver(link(realtimeURL("483920")))
        rig.realtime.cancel()
        await settleMainActor()
        XCTAssertEqual(rig.realtime.joinCode, "483920")
        XCTAssertNil(rig.coordinator.waiting)

        // Every later call is a no-op: nothing is waiting.
        rig.realtime.updateJoinCode("111111")
        rig.coordinator.applyIfSafe()
        rig.coordinator.applyIfSafe()
        await settleMainActor()
        XCTAssertEqual(rig.realtime.joinCode, "111111",
                       "a spent link was applied a second time")
        XCTAssertEqual(rig.realtimeText.joinCode, "483920",
                       "a spent link was applied a second time")
    }

    // MARK: - what the waiting watcher costs

    /// The watcher wakes on the busy BOUNDARY, never on the publishes in
    /// between.
    ///
    /// This is a cost claim, not a behaviour claim, which is why it is asserted
    /// on the signal rather than through the coordinator: both wirings apply the
    /// link at the same moment, and the difference is only how many times the
    /// app woke up to decide not to. That difference is not small.
    /// `CloudDownloadModel` publishes on every keystroke in the link field and
    /// again for every chunk of a running download, and each publish used to
    /// schedule a main-actor `Task` — so a link waiting behind a large transfer
    /// cost a hop per chunk, growing with the file rather than with anything the
    /// user did.
    ///
    /// `busyChanges` is the publisher `watchForIdle` subscribes to, and the
    /// typing below is a real firehose: one publish per character, none of which
    /// changes whether work is in flight.
    func testTheWaitingWatchWakesOnBusyEdgesRatherThanEveryPublish() async {
        let rig = makeRig()
        var publishes = 0
        var edges: [Bool] = []
        let counted = rig.download.objectWillChange.sink { _ in publishes += 1 }
        let watched = rig.download.busyChanges.sink { edges.append($0) }
        defer { counted.cancel(); watched.cancel() }

        var typed = ""
        for character in downloadURL.absoluteString {
            typed.append(character)
            rig.download.linkText = typed
        }
        rig.download.resolve()
        await waitFor("the stubbed 404 to land", { !rig.download.isBusy })

        XCTAssertEqual(edges, [false, true, false],
                       "the busy signal is not edge-triggered: \(edges.count) wake-ups")
        XCTAssertGreaterThan(publishes, 30,
                             "the typing did not actually produce a firehose to ignore")

        // The chunk case the stubbed failure above cannot reach, from the other
        // side: progress moves inside one state case, so two different progress
        // values are the same answer and `removeDuplicates` swallows every one
        // of them.
        XCTAssertTrue(CloudDownloadModel.isBusy(.downloading(received: 1, total: 9)))
        XCTAssertTrue(CloudDownloadModel.isBusy(.downloading(received: 8, total: 9)))
        XCTAssertFalse(CloudDownloadModel.isBusy(.failed("stop")))
    }

    /// The wiring behind that claim, which no behavioural test can see: the
    /// coordinator subscribes to the edge publisher and not to
    /// `objectWillChange`.
    ///
    /// Asserted on the source because the two produce identical outcomes — a
    /// revert to `objectWillChange` would keep every other test in this file
    /// green while restoring one main-actor `Task` per chunk of every transfer a
    /// link waits behind.
    func testTheWatcherSubscribesToTheEdgeSignalRatherThanEveryPublish() throws {
        let coordinator = try String(contentsOf: coordinatorSource, encoding: .utf8)
        let code = coordinator.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")

        for model in ["download.busyChanges", "realtime.busyChanges",
                      "realtimeText.busyChanges"] {
            XCTAssertTrue(code.contains(model), "the watcher stopped observing \(model)")
        }
        XCTAssertFalse(code.contains("objectWillChange"),
                       "the watcher is back to waking on every publish")
        // The other half of the privacy claim, in the form a reviewer would
        // reintroduce it: a stored array of links.
        XCTAssertFalse(code.contains("[AppDeepLink]"),
                       "the coordinator keeps a history of links again")
    }

    /// …/Tests/RelayiumKitTests/<this file> → the coordinator's own source.
    private var coordinatorSource: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // RelayiumKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // RelayiumKit
            .appendingPathComponent("Sources/RelayiumAppKit/AppDeepLinkCoordinator.swift")
    }

    // MARK: - the router's half

    /// An invalid URL is refused before anything is stored, so a hostile or
    /// mistyped link cannot discard a valid one that has not been acted on yet.
    ///
    /// The list is the production one: a wrong scheme, a wrong host, a host that
    /// only looks right until the userinfo is read, a non-443 port, a `/d/` link
    /// with no key, a malformed or non-numeric code, an extra fragment
    /// parameter, and a path this app does not serve.
    func testAnInvalidURLNeverReplacesAValidPendingLink() {
        let router = AppDeepLinkRouter()
        XCTAssertTrue(router.open(realtimeURL("483920")))

        for hostile in ["http://relayium.com/d/a#k=K",
                        "https://evil.example/d/a#k=K",
                        "https://relayium.com@evil.example/d/a#k=K",
                        "https://user:pw@relayium.com/d/a#k=K",
                        "https://relayium.com:8443/d/a#k=K",
                        "https://relayium.com/d/a",
                        "https://relayium.com/cross-network#c=48392a",
                        "https://relayium.com/cross-network#c=4839201",
                        "https://relayium.com/cross-network#c=483920&next=evil",
                        "https://relayium.com/not-a-route",
                        "https://relayium.com/",
                        "relayium://cross-network?c=483920"] {
            XCTAssertFalse(router.open(URL(string: hostile)!), hostile)
            XCTAssertEqual(router.pending, .realtime(code: "483920"), hostile)
        }
    }

    /// The shells consume one main-actor turn late, for the `willSet` ordering
    /// reason `AppDeepLinkTests` pins. A second link can land inside that gap,
    /// and a bare `consume()` would throw it away: the shell has never seen it,
    /// and `Published` does not re-emit a value it has already emitted.
    func testConsumingByExpectedLinkCannotClearANewerOne() {
        let router = AppDeepLinkRouter()
        XCTAssertTrue(router.open(realtimeURL("111111")))
        let firstSeen = router.pending
        XCTAssertTrue(router.open(realtimeURL("222222")))

        // The deferred consume for the FIRST link now runs.
        router.consume(try! XCTUnwrap(firstSeen))
        XCTAssertEqual(router.pending, .realtime(code: "222222"),
                       "a stale consume discarded the link the user just opened")

        router.consume(.realtime(code: "222222"))
        XCTAssertNil(router.pending)
    }

    /// The whole hand-off, in the order the shell runs it, twice — because the
    /// second run is the one that catches a router left holding a spent link.
    func testTheShellHandOffAppliesEachLinkExactlyOnce() async {
        let rig = makeRig()
        let router = AppDeepLinkRouter()
        var delivered: [AppDeepLink] = []
        let subscription = router.$pending.compactMap { $0 }.sink { link in
            delivered.append(link)
            rig.coordinator.deliver(link)
            Task { @MainActor in router.consume(link) }
        }
        defer { subscription.cancel() }

        XCTAssertTrue(router.open(realtimeURL("111111")))
        await settleMainActor()
        XCTAssertNil(router.pending, "the spent link was left for a late subscriber to replay")

        XCTAssertTrue(router.open(realtimeURL("222222")))
        await settleMainActor()
        XCTAssertNil(router.pending)

        XCTAssertEqual(delivered, [.realtime(code: "111111"), .realtime(code: "222222")])
        XCTAssertEqual(rig.realtime.joinCode, "222222")
        XCTAssertEqual(rig.realtimeText.joinCode, "222222")
        // Two links, two navigations: a third would be a link applied twice, and
        // `selectionWrites` is the model's own count rather than anything this
        // coordinator remembers about the links themselves.
        XCTAssertEqual(rig.navigation.selectionWrites, 2)
        XCTAssertNil(rig.coordinator.waiting)
    }
}
