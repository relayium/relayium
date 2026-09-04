import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

/// Every socket a model has opened, in order. Two live at once would put this
/// Mac in the room twice, under two peer ids, and every other device would see
/// it as two devices.
final class SocketLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _channels: [FakeWebSocketChannel] = []
    var channels: [FakeWebSocketChannel] { lock.lock(); defer { lock.unlock() }; return _channels }
    func open() -> FakeWebSocketChannel {
        let ch = FakeWebSocketChannel()
        lock.lock(); _channels.append(ch); lock.unlock()
        return ch
    }
}

/// The same-network roster is the one place in the app where the user is asked
/// to pick a peer out of a room that can hold more than two — and where the
/// room's membership is decided by a shared public IP rather than by anyone
/// agreeing on a code. Every test here is a way that goes wrong.
@MainActor
final class LanDiscoveryTests: XCTestCase {
    private var channel = FakeWebSocketChannel()

    private func makeModel() -> LanDiscoveryModel {
        channel = FakeWebSocketChannel()
        let ch = channel
        return LanDiscoveryModel(connect: {
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            return client
        })
    }

    /// Callbacks hop to the main actor because the real socket delivers them
    /// from URLSession's queue.
    private func settle() async { await Task.yield(); await Task.yield() }

    private func welcome(_ id: String) { channel.fireText(#"{"type":"welcome","name":"\#(id)","ip":"1.2.3.4"}"#) }

    private func roster(_ peers: [(String, String)]) {
        let body = peers.map { #"{"id":"\#($0.0)","name":"\#($0.1)"}"# }.joined(separator: ",")
        channel.fireText(#"{"type":"peers","peers":[\#(body)]}"#)
    }

    // MARK: - self exclusion

    /// The hub broadcasts the whole room to every member, so our own entry is
    /// always in the roster. Offering it would let the user send to themselves,
    /// which in WebRTC terms is dialling our own peer id — a bare NSError and a
    /// dead session.
    func testExcludesItselfFromTheRoster() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()

        XCTAssertEqual(model.devices.map(\.id), ["other-2"])
        XCTAssertEqual(model.state, .joined)
    }

    /// Before `welcome` there is no way to tell which entry is ours, so nothing
    /// is listed rather than something guessed at.
    func testListsNothingBeforeItKnowsItsOwnID() async {
        let model = makeModel()
        model.start()
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()

        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertEqual(model.state, .connecting)

        welcome("self-1")
        await settle()
        XCTAssertEqual(model.devices.map(\.id), ["other-2"], "the held roster must be reapplied once self is known")
    }

    /// `welcome` can arrive before this model installs `onSelfId` — the socket
    /// stores the id precisely because a late subscriber still has to be able to
    /// answer "which of these is me". Without the fallback the symptom is a
    /// room that lists nobody, forever, with no error anywhere.
    func testRecoversAWelcomeThatLandedBeforeItSubscribed() async {
        channel = FakeWebSocketChannel()
        let ch = channel
        let model = LanDiscoveryModel(connect: {
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            ch.fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
            return client
        })
        model.start()
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()

        XCTAssertEqual(model.devices.map(\.id), ["other-2"])
        XCTAssertEqual(model.state, .joined)
    }

    /// Even a direct call with our own id — a UI that resolved a row wrongly,
    /// a stale binding — must not produce a selection.
    func testCannotSelectItself() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()

        model.select("self-1")
        XCTAssertNil(model.selectedId)
    }

    // MARK: - never choosing for the user

    /// A room of one other device is the common case, and auto-selecting it is
    /// the tempting shortcut. It is also how a device that merely shares a
    /// public IP — a carrier NAT, an office, a VPN exit — becomes the default
    /// recipient of somebody's files.
    func testNeverSelectsAPeerOnItsOwn() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("only-2", "Phone")])
        await settle()

        XCTAssertEqual(model.devices.count, 1)
        XCTAssertNil(model.selectedId, "a single nearby device is still a choice the user makes")
        XCTAssertNil(model.selectedDevice)

        roster([("self-1", "Mac"), ("only-2", "Phone"), ("third-3", "Tablet")])
        await settle()
        XCTAssertNil(model.selectedId)
    }

    /// An id that is not in the room cannot be selected, however it was
    /// obtained.
    func testRejectsAnIDThatIsNotInTheRoom() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()

        model.select("ghost-9")
        XCTAssertNil(model.selectedId)

        model.select("other-2")
        XCTAssertEqual(model.selectedId, "other-2")
    }

    // MARK: - stale roster and stale selection

    /// The selected device leaves. Keeping the selection would let the next
    /// Send dial an id the room no longer contains — and hub ids are handed
    /// out per connection, so it could by then belong to somebody else.
    func testASelectedDeviceLeavingClearsTheSelection() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()
        model.select("other-2")
        XCTAssertEqual(model.selectedId, "other-2")

        roster([("self-1", "Mac"), ("third-3", "Tablet")])
        await settle()

        XCTAssertNil(model.selectedId, "the chosen device is gone; the selection cannot outlive it")
        XCTAssertNil(model.selectedDevice)
        XCTAssertEqual(model.devices.map(\.id), ["third-3"])
    }

    /// Losing the socket empties everything: a roster nobody is maintaining is
    /// a list of devices that may not be there, and the state has to say so.
    ///
    /// It says "reconnecting", not "failed": this socket is what makes the Mac
    /// reachable, so a drop that ended in a dead end would silently stop
    /// background receive until somebody noticed and pressed a button.
    func testADroppedSocketEmptiesTheRoomAndSaysItIsReconnecting() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()
        model.select("other-2")

        channel.fireRemoteClose()
        await settle()

        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertNil(model.selectedId)
        XCTAssertNil(model.client)
        XCTAssertFalse(model.isScanning, "an unmaintained roster must not read as a live one")
        guard case .reconnecting = model.state else { return XCTFail("got \(model.state)") }
        model.stop()   // drop the pending retry before the test ends
    }

    /// Operation identity: a roster frame from a socket the user stopped must
    /// not repopulate the list they closed.
    func testAStoppedSocketCannotRepopulateTheRoster() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()

        model.stop()
        XCTAssertEqual(model.state, .off)

        roster([("self-1", "Mac"), ("other-2", "Phone"), ("late-3", "Laptop")])
        await settle()
        XCTAssertTrue(model.devices.isEmpty, "a stopped scan must stay stopped")
        XCTAssertEqual(model.state, .off, "and its close callback must not be reported as a failure")
    }

    // MARK: - names are labels, ids are identity

    /// Two devices called "MacBook Pro" is the normal case, not the attack. The
    /// labels have to differ so the user can tell which is which, and the
    /// selection has to follow the id either way.
    func testDuplicateNamesGetDistinctLabelsAndDistinctIdentities() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("aaa111", "MacBook Pro"), ("bbb222", "MacBook Pro")])
        await settle()

        XCTAssertEqual(model.devices.count, 2)
        let labels = model.devices.map(\.label)
        XCTAssertEqual(Set(labels).count, 2, "two identical names must not produce two identical rows")
        XCTAssertTrue(labels.allSatisfy { $0.contains("MacBook Pro") })

        model.select("bbb222")
        XCTAssertEqual(model.selectedId, "bbb222")
        XCTAssertEqual(model.selectedDevice?.id, "bbb222", "selection follows the id, never the name")
    }

    /// A unique name is left alone: the id fragment is a disambiguator, not
    /// decoration.
    func testAUniqueNameIsShownAsItIs() {
        let devices = nearbyDevices(
            roster: [Peer(id: "self-1", name: "Mac"), Peer(id: "p2", name: "Phone")],
            selfId: "self-1")
        XCTAssertEqual(devices.map(\.label), ["Phone"])
    }

    /// Peer-supplied text lands in our UI. A right-to-left override can make
    /// "Phone" render as something else entirely, which on a screen whose whole
    /// job is "pick the right device" is the entire attack.
    func testSanitizesPeerSuppliedNames() {
        let devices = nearbyDevices(
            roster: [Peer(id: "self", name: "Mac"),
                     Peer(id: "p2", name: "Ph\u{202E}one\u{0007}"),
                     Peer(id: "p3", name: "   ")],
            selfId: "self")
        XCTAssertEqual(devices.count, 2)
        XCTAssertFalse(devices.contains { $0.name.unicodeScalars.contains { $0.value == 0x202E } })
        XCTAssertFalse(devices.contains { $0.name.unicodeScalars.contains { $0.value == 0x07 } })
        // The placeholder is localized copy now, so this asserts the CONTRACT — a
        // blank name still gets something clickable — rather than one language's
        // spelling of it.
        XCTAssertTrue(devices.contains { $0.name == L10n.t(.nearbyUnnamedDevice) },
                      "a blank name still needs something to click")
    }

    /// The hub builds its roster by ranging a Go map, so the order differs
    /// between broadcasts. A list that reshuffles under the pointer is a list
    /// that gets misclicked.
    func testOrderIsStableAcrossReorderedRosters() {
        let a = nearbyDevices(roster: [Peer(id: "self", name: "Mac"),
                                       Peer(id: "p2", name: "Zeta"),
                                       Peer(id: "p3", name: "Alpha")],
                              selfId: "self")
        let b = nearbyDevices(roster: [Peer(id: "p3", name: "Alpha"),
                                       Peer(id: "self", name: "Mac"),
                                       Peer(id: "p2", name: "Zeta")],
                              selfId: "self")
        XCTAssertEqual(a.map(\.id), b.map(\.id))
        XCTAssertEqual(a.map(\.id), ["p3", "p2"])
    }

    /// A duplicated id in one frame must collapse rather than produce two rows
    /// that are the same device.
    func testDeduplicatesRepeatedIDs() {
        let devices = nearbyDevices(
            roster: [Peer(id: "self", name: "Mac"),
                     Peer(id: "p2", name: "Phone"),
                     Peer(id: "p2", name: "Phone")],
            selfId: "self")
        XCTAssertEqual(devices.map(\.id), ["p2"])
    }

    // MARK: - capability announcements

    private func capsHello(from peer: String, _ caps: [String]) {
        let list = caps.map { "\"\($0)\"" }.joined(separator: ",")
        channel.fireText(#"{"type":"signal","from":"\#(peer)","data":{"caps":[\#(list)]}}"#)
    }

    /// A hello can land before `welcome` does — the two are independent frames
    /// on one socket, and a peer already in the room announces the instant it
    /// sees us join. Retaining against the roster at that moment retains against
    /// an EMPTY list, because there is no self id to exclude ourselves by yet,
    /// and the announcement we had already correctly received is thrown away.
    func testAnnouncementArrivingBeforeWelcomeSurvives() async {
        let model = makeModel()
        model.start()
        capsHello(from: "other-2", [TEXT_CAPABILITY])
        await settle()
        welcome("self-1")
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        await settle()
        XCTAssertTrue(model.capabilities.supports("other-2", TEXT_CAPABILITY))
    }

    func testAnnouncementsAreDiscardedWithThePeerAndWithTheRoom() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("other-2", "Phone")])
        capsHello(from: "other-2", [TEXT_CAPABILITY])
        await settle()
        XCTAssertTrue(model.capabilities.supports("other-2", TEXT_CAPABILITY))

        // The peer left the room.
        roster([("self-1", "Mac")])
        await settle()
        XCTAssertFalse(model.capabilities.supports("other-2", TEXT_CAPABILITY))

        // …and a whole room epoch ends. A peer id means nothing outside the room
        // that issued it, so nothing may be inherited across a reconnect.
        capsHello(from: "other-3", [TEXT_CAPABILITY])
        await settle()
        model.stop()
        XCTAssertFalse(model.capabilities.supports("other-3", TEXT_CAPABILITY))
    }

    // MARK: - delivery order
    //
    // The reverse-direction defect physical run `7e1970a0` caught, in one
    // sequence. An announcement is recorded SYNCHRONOUSLY on the delivery queue
    // — `LinkRoomRouter.intercept` gates the frame behind it inline there — while
    // every other socket edge reaches this model through its own
    // `Task { @MainActor }`. So a self-only roster delivered BEFORE a peer's
    // hello is projected AFTER it, retains the registry against a membership
    // that predates the hello, and deletes it one hop before the roster naming
    // that peer is projected. The device is then listed with no capabilities and
    // the unified link silently falls back to the legacy surface.
    //
    // Most tests below therefore fire a whole burst with NO settle in between:
    // that is what leaves the projections queued and out of step with the
    // delivery queue. The last two do not rely on the scheduler at all — they
    // stamp and apply roster frames directly, because "these two independent
    // Tasks ran in the other order" is not something a burst can be made to
    // demonstrate on purpose.

    /// The exact mini-5 order: welcome, the self-only roster, the peer's
    /// `link/1` hello, then the complete roster — all delivered before any
    /// projection runs.
    func testASelfOnlyRosterCannotDeleteAHelloDeliveredAfterIt() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac")])
        capsHello(from: "peer-2", [TEXT_CAPABILITY, LINK_CAPABILITY])
        roster([("self-1", "Mac"), ("peer-2", "iPad")])
        await settle()

        XCTAssertEqual(model.devices.map(\.id), ["peer-2"])
        XCTAssertEqual(model.devices.first?.supportsLink, true,
                       "the roster that predates the hello deleted it before the complete roster landed")
        XCTAssertEqual(model.devices.first?.announcesLegacyText, true)
        XCTAssertTrue(model.capabilities.supports("peer-2", LINK_CAPABILITY))
    }

    /// The same burst, with the roster frames the other way round: a peer that
    /// genuinely LEFT must still lose its announcement. This is the mutation
    /// that separates ordering from "never prune anything" — a repair that
    /// ignored delivery order would resurrect this peer.
    func testARosterDeliveredAfterAHelloStillPrunesTheDepartedPeer() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("gone-2", "iPad")])
        capsHello(from: "gone-2", [TEXT_CAPABILITY, LINK_CAPABILITY])
        roster([("self-1", "Mac")])
        await settle()

        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertFalse(model.capabilities.supports("gone-2", LINK_CAPABILITY),
                       "a roster frame delivered after the hello is entitled to prune it")
        XCTAssertFalse(model.capabilities.supports("gone-2", TEXT_CAPABILITY))
    }

    /// And the protection is spent by the first roster frame entitled to answer
    /// it: a hello held through one stale prune is dropped by the NEXT roster
    /// that omits its peer, so nothing accumulates for the life of the room.
    func testAHeldAnnouncementIsPrunedByTheNextRosterThatOmitsIt() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac")])
        capsHello(from: "peer-2", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        XCTAssertTrue(model.capabilities.supports("peer-2", LINK_CAPABILITY),
                      "the hello outlives the roster it was delivered after")

        // A later self-only roster: this one WAS delivered after the hello, so
        // it is membership authority over it.
        roster([("self-1", "Mac")])
        await settle()
        XCTAssertFalse(model.capabilities.supports("peer-2", LINK_CAPABILITY))
        XCTAssertTrue(model.devices.isEmpty)
    }

    /// Delivery order is per socket. A roster frame from a socket this model has
    /// already replaced must not prune — or repair — anything in the room that
    /// followed it, because its peer ids and its positions both died with it.
    func testARosterFromAReplacedSocketTouchesNeitherRoomsAnnouncements() async {
        let log = SocketLog()
        let model = LanDiscoveryModel(connect: {
            let ch = log.open()
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            return client
        }, sleep: { _ in })
        model.start()
        log.channels[0].fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        log.channels[0].fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"},{"id":"old-2","name":"iPad"}]}"#)
        await settle()
        XCTAssertEqual(model.devices.map(\.id), ["old-2"])

        // "Look again": the first socket is torn down and a second room begins.
        model.start()
        XCTAssertEqual(log.channels.count, 2)
        log.channels[1].fireText(#"{"type":"welcome","name":"self-9","ip":"1.2.3.4"}"#)
        log.channels[1].fireText(#"{"type":"signal","from":"new-9","data":{"caps":["text/1","link/1"]}}"#)
        log.channels[1].fireText(#"{"type":"peers","peers":[{"id":"self-9","name":"Mac"},{"id":"new-9","name":"iPad"}]}"#)
        // …and the dead socket's roster finally arrives.
        log.channels[0].fireText(#"{"type":"peers","peers":[{"id":"self-1","name":"Mac"}]}"#)
        await settle()

        XCTAssertEqual(model.devices.map(\.id), ["new-9"])
        XCTAssertEqual(model.devices.first?.supportsLink, true,
                       "a replaced socket's roster reached this room's registry")
        XCTAssertTrue(model.capabilities.supports("new-9", LINK_CAPABILITY))
        model.stop()
    }

    /// **Two roster projections, applied in the opposite order to delivery.**
    ///
    /// Each roster frame reaches this model through its own
    /// `Task { @MainActor }`, and independent tasks carry no ordering guarantee
    /// between them — the frame stamped second can run first. Applied
    /// explicitly rather than fired in a burst, because trusting the scheduler
    /// to reverse two tasks is not a test of anything.
    ///
    /// Without the guard the older frame wins twice: it overwrites the roster
    /// with membership the room has already superseded, and it leaves
    /// `rosterPosition` behind, so the next prune is judged against a stale
    /// frame.
    func testAnOlderRosterProjectionCannotOverwriteANewerOneThatAlreadyRan() async {
        let model = makeModel()
        let registry = model.capabilities
        model.start()
        welcome("self-1")
        await settle()

        // Delivery order: the self-only frame, then the complete one, then the
        // peer's hello behind both.
        let selfOnly = registry.rosterDelivered()
        let complete = registry.rosterDelivered()
        registry.record(peerId: "peer-2", signal: capsField([TEXT_CAPABILITY, LINK_CAPABILITY]))

        // Application order: the newer frame first.
        model.applyDeliveredRoster([Peer(id: "self-1", name: "Mac"),
                                    Peer(id: "peer-2", name: "iPad")], deliveredAt: complete)
        XCTAssertEqual(model.devices.map(\.id), ["peer-2"])

        model.applyDeliveredRoster([Peer(id: "self-1", name: "Mac")], deliveredAt: selfOnly)
        XCTAssertEqual(model.devices.map(\.id), ["peer-2"],
                       "a roster frame older than the one already applied overwrote it")
        XCTAssertTrue(registry.supports("peer-2", LINK_CAPABILITY))

        // …and the room's next actual answer is still authoritative. The stale
        // frame consumed nothing on its way through.
        model.applyDeliveredRoster([Peer(id: "self-1", name: "Mac")],
                                   deliveredAt: registry.rosterDelivered())
        XCTAssertTrue(model.devices.isEmpty)
        XCTAssertFalse(registry.supports("peer-2", LINK_CAPABILITY))
        model.stop()
    }

    /// A peer whose announcement is spared is spared in the REGISTRY and
    /// nowhere else: it is not listed, not selectable, and not published to a
    /// room observer as membership. `LinkRoomRouter.rosterChanged` acts on that
    /// membership — it cancels a pending request whose target is absent — so a
    /// peer smuggled into it would be a peer the room never named.
    func testASparedPeerIsNotListedSelectableOrAnnouncedAsMembership() async {
        let model = makeModel()
        let registry = model.capabilities
        let rosters = RosterLog()
        model.addRoomObserver(rosters)
        model.start()
        welcome("self-1")
        await settle()

        let selfOnly = registry.rosterDelivered()
        registry.record(peerId: "peer-2", signal: capsField([TEXT_CAPABILITY, LINK_CAPABILITY]))
        model.applyDeliveredRoster([Peer(id: "self-1", name: "Mac")], deliveredAt: selfOnly)

        XCTAssertTrue(registry.supports("peer-2", LINK_CAPABILITY),
                      "the roster frame predates the hello and may not take it")
        XCTAssertTrue(model.devices.isEmpty, "a spared peer was listed")
        model.select("peer-2")
        XCTAssertNil(model.selectedId, "a spared peer was selectable")
        XCTAssertEqual(rosters.rosters, [[]], "a spared peer was announced as membership")
        model.stop()
    }

    // MARK: - a hello is not a roster frame
    //
    // The macOS-1.2.4 defect, in one sequence: a peer reconnects, the hub issues
    // it a NEW id, and it announces the instant it sees the room — before the
    // hub's next `peers` broadcast has landed. The old code answered that hello
    // by running the whole roster path against the roster it still held, which
    // deleted the announcement one line after recording it AND republished a
    // membership set the replacement peer was not in. The symptom was a codeless
    // LAN link that flashed and then stuck until the app was restarted.

    /// The registry half. A hello from a peer no roster frame has delivered yet
    /// must survive until a roster frame actually says the peer is gone.
    func testAHelloFromAPeerNotYetInTheRosterIsNotPrunedAgainstIt() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("old-2", "Phone")])
        await settle()

        capsHello(from: "new-3", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()

        XCTAssertTrue(model.capabilities.supports("new-3", LINK_CAPABILITY),
                      "the replacement peer's announcement was pruned against the roster it predates")
        XCTAssertEqual(model.devices.map(\.id), ["old-2"],
                       "a peer no roster frame has delivered is not listed either")

        // The replacement roster finally lands. The announcement recorded before
        // it is what makes this peer immediately usable as a link.
        roster([("self-1", "Mac"), ("new-3", "Phone")])
        await settle()
        XCTAssertEqual(model.devices.map(\.id), ["new-3"])
        XCTAssertEqual(model.devices.first?.supportsLink, true)
        XCTAssertFalse(model.capabilities.supports("old-2", LINK_CAPABILITY),
                       "a roster frame is still the thing that prunes a departed peer")
    }

    /// The observer half. A hello must not announce a roster at all — the set it
    /// would announce is the stale one, and `LinkRoomRouter.rosterChanged`
    /// cancels a pending request whose target is absent from the set it is given.
    func testAHelloAnnouncesNoRosterWhileARosterFrameStillDoes() async {
        let model = makeModel()
        let observer = RosterLog()
        model.addRoomObserver(observer)
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("old-2", "Phone")])
        await settle()
        XCTAssertEqual(observer.rosters, [["old-2"]])

        capsHello(from: "new-3", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        XCTAssertEqual(observer.rosters, [["old-2"]],
                       "hearing from a peer republished a roster it is not in")

        // Reverse mutation: the roster frame itself must still announce, or this
        // test would pass on a model that announces nothing at all.
        roster([("self-1", "Mac"), ("new-3", "Phone")])
        await settle()
        XCTAssertEqual(observer.rosters, [["old-2"], ["new-3"]])
    }

    /// The consequence, against the real router: the in-flight request to the
    /// replacement peer must survive hearing from it.
    func testAHelloFromTheRequestedPeerDoesNotCancelTheRequest() async {
        let model = makeModel()
        model.start()
        welcome("self-1")
        roster([("self-1", "Mac"), ("old-2", "Phone")])
        await settle()
        let socket = try! XCTUnwrap(model.client)

        let admission = LinkAdmission(selfId: { "self-1" }, supportsLink: { _ in true })
        let session = LinkRoomSession(admission: admission) { _, _, _ in
            preconditionFailure("no establishment is reached in this test")
        }
        let router = LinkRoomRouter(admission: admission,
                                    capabilities: model.capabilities,
                                    session: session,
                                    scheduler: InertScheduler())
        router.attach(to: socket)
        // Held for the test's whole body: the model's observer registry is weak,
        // and an observer that has gone hears no roster at all — which would make
        // every "the request survived" assertion below pass for the wrong reason.
        let forwarder = RouterObserver(router: router)
        model.addRoomObserver(forwarder)

        let operation = router.ensure(peerId: "new-3")
        XCTAssertNil(operation.settledOutcome, "the request is in flight")

        capsHello(from: "new-3", [TEXT_CAPABILITY, LINK_CAPABILITY])
        await settle()
        XCTAssertNil(operation.settledOutcome,
                     "hearing from the requested peer withdrew the ask being made to it")

        // The replacement roster contains it, so nothing changes.
        roster([("self-1", "Mac"), ("new-3", "Phone")])
        await settle()
        XCTAssertNil(operation.settledOutcome)

        // Reverse mutation: a roster frame that genuinely DROPS the target is
        // still authority to withdraw the ask. Without this the assertions above
        // would hold on a model that never announced a roster to anybody.
        roster([("self-1", "Mac"), ("old-2", "Phone")])
        await settle()
        XCTAssertEqual(operation.settledOutcome, .cancelled)

        withExtendedLifetime(forwarder) {}
        router.detach()
        model.stop()
    }

    // MARK: - the name this Mac is announced under

    /// The roster shows names and this Mac's own name was nowhere on the
    /// receive screen, so "which of these is me" had no answer.
    ///
    /// The value has to come from the SOCKET, not from the system: the device
    /// name is read once, when the socket is built, so renaming the Mac changes
    /// what the system reports and not what the room was told. A surface showing
    /// the live name would be telling the user to look for something no other
    /// device can see.
    func testTheAnnouncedNameIsTheOneTheCurrentSocketActuallyJoinedWith() async {
        let model = makeModel()
        XCTAssertNil(model.announcedName, "no socket, no claim about any room")
        model.start()
        await settle()
        XCTAssertEqual(model.announcedName, "Mac")
    }

    /// Renaming the Mac between sockets is exactly the situation this guards.
    /// Until the socket is replaced, the room still sees the old name — and so
    /// does the surface.
    func testARenameIsInvisibleUntilTheSocketIsReplaced() async {
        var announced = "Old name"
        let log = SocketLog()
        let model = LanDiscoveryModel(connect: {
            let ch = log.open()
            let client = SignalingClient(channel: ch, name: announced)
            ch.fireOpen()
            return client
        }, sleep: { _ in })
        model.start()
        await settle()
        XCTAssertEqual(model.announcedName, "Old name")

        announced = "New name"
        await settle()
        XCTAssertEqual(model.announcedName, "Old name",
                       "the room has not been told, so the surface must not claim it")

        model.start()
        await settle()
        XCTAssertEqual(model.announcedName, "New name",
                       "a replaced socket announces the current name")
    }

    /// Cleared with the socket that announced it. A name left behind after a
    /// pause or a stop is a claim about a room this Mac is no longer in.
    func testTheAnnouncedNameIsClearedWheneverTheSocketEnds() async {
        let model = makeModel()
        model.start()
        await settle()
        XCTAssertNotNil(model.announcedName)
        model.pause()
        XCTAssertNil(model.announcedName, "a paused Mac announces nothing")

        model.resume()
        await settle()
        XCTAssertNotNil(model.announcedName)
        model.stop()
        XCTAssertNil(model.announcedName, "a stopped Mac announces nothing")
    }

    /// A DROP is the other way a socket ends, and it does not go through
    /// `teardown()`. Between the drop and the next join this Mac is announced to
    /// nobody, so the last socket's name must not survive the gap — the next
    /// socket earns its own, and may earn a different one.
    func testADroppedSocketAnnouncesNothingUntilItHasRejoined() async {
        let model = makeModel()
        model.start()
        await settle()
        XCTAssertEqual(model.announcedName, "Mac")

        channel.fireRemoteClose()
        await settle()
        XCTAssertNil(model.announcedName,
                     "a reconnecting Mac is in no room and must claim no name in one")
    }

}

// ── residency: the socket that makes this Mac reachable ─────────────────────
//
// Background receive is only as good as the room membership under it, so every
// test here is a way the app silently stops being reachable.
@MainActor
final class LanResidencyTests: XCTestCase {
    private func settle() async { await Task.yield(); await Task.yield(); await Task.yield() }

    /// Residency is the default. Nothing is pressed and no window has to be
    /// open for this Mac to be in the room.
    func testStartsAutomaticallyAndIsIdempotent() async {
        let log = SocketLog()
        let model = LanDiscoveryModel(connect: {
            let ch = log.open()
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            return client
        }, sleep: { _ in })

        model.startResident()
        XCTAssertEqual(model.state, .connecting)
        XCTAssertNotNil(model.client)

        // Every window that appears calls this. A second socket would put this
        // Mac in the room twice.
        model.startResident()
        model.startResident()
        XCTAssertEqual(log.channels.count, 1)
        model.stop()
    }

    /// A drop reconnects on its own, with the old socket gone before the new
    /// one opens.
    func testADroppedSocketReconnectsWithoutDuplicatingItself() async {
        let log = SocketLog()
        let model = LanDiscoveryModel(connect: {
            let ch = log.open()
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            return client
        }, sleep: { _ in })
        model.startResident()
        log.channels[0].fireText(#"{"type":"welcome","name":"self-1","ip":"1.2.3.4"}"#)
        await settle()
        XCTAssertEqual(model.state, .joined)

        log.channels[0].fireRemoteClose()
        for _ in 0..<50 where log.channels.count < 2 { await settle() }

        XCTAssertEqual(log.channels.count, 2, "a dropped socket must be replaced, not mourned")
        XCTAssertTrue(log.channels[0].closed || !log.channels[0].isOpen,
                      "the old socket must be gone before the new one opens")
        XCTAssertEqual(model.state, .connecting)

        log.channels[1].fireText(#"{"type":"welcome","name":"self-2","ip":"1.2.3.4"}"#)
        await settle()
        XCTAssertEqual(model.state, .joined)
        model.stop()
    }

    /// Backoff is bounded but never gives up: the usual cause is a network this
    /// Mac will rejoin, and a listener that stops retrying is one that has
    /// silently stopped receiving.
    func testBackoffIsBoundedAndNonDecreasing() {
        let steps = LanDiscoveryModel.reconnectBackoff
        XCTAssertFalse(steps.isEmpty)
        XCTAssertEqual(steps, steps.sorted(), "backoff must not shrink under repeated failure")
        XCTAssertGreaterThan(steps[0], 0, "an immediate retry is a hot loop against the hub")
        XCTAssertLessThanOrEqual(steps.last ?? .infinity, 60,
                                 "a cap this long is an app that looks off for a minute")
    }

    /// A retry armed for a socket epoch that has since been replaced must not
    /// open a second one on top of the live socket.
    func testAStaleRetryCannotOpenASecondSocket() async {
        let log = SocketLog()
        let released = Gate2()
        let model = LanDiscoveryModel(connect: {
            let ch = log.open()
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            return client
        }, sleep: { _ in await released.wait() })

        model.startResident()
        log.channels[0].fireRemoteClose()          // arms a retry, held on the gate
        await settle()
        guard case .reconnecting = model.state else { return XCTFail("got \(model.state)") }

        model.start()                              // the user pressed "Look again" first
        XCTAssertEqual(log.channels.count, 2)

        await released.open()                      // the stale retry finally wakes
        for _ in 0..<20 { await settle() }
        XCTAssertEqual(log.channels.count, 2, "a superseded retry must not open a third socket")
        model.stop()
    }

    /// An explicit pause is truthful and sticky: nothing listens, nothing
    /// retries, and the launch path must not quietly undo it.
    func testPauseStopsListeningAndSurvivesAResidentStart() async {
        let log = SocketLog()
        let model = LanDiscoveryModel(connect: {
            let ch = log.open()
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            return client
        }, sleep: { _ in })
        model.startResident()
        XCTAssertEqual(log.channels.count, 1)

        model.pause()
        XCTAssertEqual(model.state, .paused)
        XCTAssertTrue(model.isPaused)
        XCTAssertNil(model.client)

        // A reopened window calls this again; it must not resume receiving on
        // the user's behalf.
        model.startResident()
        XCTAssertEqual(model.state, .paused)
        XCTAssertEqual(log.channels.count, 1)

        model.resume()
        XCTAssertEqual(log.channels.count, 2)
        XCTAssertEqual(model.state, .connecting)
        model.stop()
    }

    /// A socket that drops while paused stays paused rather than reconnecting
    /// behind the user's back.
    func testAPausedModelDoesNotReconnect() async {
        let log = SocketLog()
        let model = LanDiscoveryModel(connect: {
            let ch = log.open()
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            return client
        }, sleep: { _ in })
        model.startResident()
        model.pause()
        // Whatever the dead socket does now, it is not our socket any more.
        log.channels[0].fireRemoteClose()
        for _ in 0..<20 { await settle() }
        XCTAssertEqual(model.state, .paused)
        XCTAssertEqual(log.channels.count, 1)
        model.stop()
    }

    /// Stop is teardown, not pause: it leaves the room and stays out, and a
    /// close arriving afterwards is not a drop worth reconnecting from.
    func testStopEndsResidencyOutright() async {
        let log = SocketLog()
        let model = LanDiscoveryModel(connect: {
            let ch = log.open()
            let client = SignalingClient(channel: ch, name: "Mac")
            ch.fireOpen()
            return client
        }, sleep: { _ in })
        model.startResident()
        model.stop()
        XCTAssertEqual(model.state, .off)
        log.channels[0].fireRemoteClose()
        for _ in 0..<20 { await settle() }
        XCTAssertEqual(model.state, .off)
        XCTAssertEqual(log.channels.count, 1)
    }

}

/// Every roster the model announced, in order and as sorted arrays so an
/// assertion reads as the room rather than as a `Set`'s description.
@MainActor
private final class RosterLog: NearbyRoomObserver {
    private(set) var rosters: [[String]] = []
    func roomDidConnect(_ signaling: SignalingClient) {}
    func roomDidDisconnect() {}
    func roomRosterChanged(peerIds: Set<String>) { rosters.append(peerIds.sorted()) }
}

/// The exact forwarding `LinkWorkspaceModel` does for the same-network room:
/// representative presence withdraws an ask, physical departure ends a
/// lifecycle. Reproduced here rather than composing the whole workspace, so the
/// test names one seam.
@MainActor
private final class RouterObserver: NearbyRoomObserver {
    private let router: LinkRoomRouter
    init(router: LinkRoomRouter) { self.router = router }
    func roomDidConnect(_ signaling: SignalingClient) {}
    func roomDidDisconnect() {}
    func roomRosterChanged(peerIds: Set<String>) { router.rosterChanged(peerIds: peerIds) }
    func roomPeerLeft(_ peerId: String) { router.peerLeft(peerId) }
}

/// Records nothing and fires nothing: these tests are about what a roster frame
/// does to a request, never about its retry cadence or its timeout.
private final class InertScheduler: LinkRecoveryScheduler, @unchecked Sendable {
    private final class Handle: LinkRecoveryTimer { func cancel() {} }
    func schedule(after delay: TimeInterval, _ body: @escaping () -> Void) -> LinkRecoveryTimer {
        Handle()
    }
}

/// One-shot rendezvous, for holding an injected sleep open across a lifecycle
/// change. (A second copy of the pattern in NearbyTransferTests, which is
/// `private` to that file.)
actor Gate2 {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var opened = false

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        for waiter in waiters { waiter.resume() }
        waiters = []
    }
}

/// **The code-less room's own hello, and the seam macOS sets it through.**
///
/// `LanDiscoveryModel` builds the announcer for the room it joins, so the
/// override has to be settable on the model rather than passed at each greeting
/// — and it has to take effect for the announcer that is actually used, which is
/// what the rebuild-on-set below exists for.
@MainActor
final class LanDiscoveryLocalHelloTests: XCTestCase {

    /// The default is what every existing consumer gets, asserted by NOT setting
    /// one. iOS composes this model too.
    func testTheDefaultLocalHelloIsTheSharedNativeAnnouncement() {
        let discovery = LanDiscoveryModel(connect: { fatalError("no socket needed") })
        XCTAssertEqual(discovery.localHello(true), linkCapsHello(linkRoomActive: true),
                       "the code-less room's default hello drifted from the shared one")
        XCTAssertEqual(peerCaps(from: discovery.localHello(true)),
                       [TEXT_CAPABILITY, LINK_CAPABILITY])
    }

    /// The macOS override, exactly `link/1`.
    func testTheLinkOnlyOverrideIsExactlyLinkOne() {
        let discovery = LanDiscoveryModel(connect: { fatalError("no socket needed") })
        discovery.localHello = linkOnlyCapsHello(linkRoomActive:)
        XCTAssertEqual(peerCaps(from: discovery.localHello(true)), [LINK_CAPABILITY])
        XCTAssertFalse(peerCaps(from: discovery.localHello(true)).contains(TEXT_CAPABILITY))
    }
}
