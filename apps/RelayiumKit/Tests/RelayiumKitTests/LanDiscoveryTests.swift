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
