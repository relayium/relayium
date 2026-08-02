import XCTest
@testable import RelayiumAppKit
@testable import RelayiumKit

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
        XCTAssertEqual(model.state, .scanning)

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
    func testADroppedSocketEmptiesTheRoomAndSaysSo() async {
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
        XCTAssertFalse(model.isScanning)
        guard case .failed = model.state else { return XCTFail("got \(model.state)") }
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
        XCTAssertTrue(devices.contains { $0.name == "Unnamed device" }, "a blank name still needs something to click")
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
}
