import Foundation
import RelayiumKit
import RelayiumShareKit

/// Why a nearby transfer could not be started, before any connection exists.
public enum NearbyError: Error, Equatable {
    /// A device was picked, but the room socket the roster came from is gone —
    /// discovery was stopped, or the signalling connection dropped in between.
    case notScanning
    /// The connection was built and the offer was sent, but the chosen device
    /// never answered.
    case noAnswer
}

/// One OTHER device in the same-network rendezvous room.
public struct NearbyDevice: Identifiable, Equatable {
    /// The signalling peer id. Selection, signalling and the connection are
    /// bound to this and never to the name: names are peer-supplied, arbitrary,
    /// and duplicated across devices as a matter of course (two Macs both
    /// called "MacBook Pro" is the normal case, not the attack).
    public let id: String
    /// What the peer called itself, sanitized for display. A label, never an
    /// identity and never a key.
    public let name: String
    /// `name`, plus a short id fragment when another device in the room is
    /// showing the same name, so two identical labels are still tellable apart
    /// before the user picks one.
    public let label: String
    /// Whether this peer announced exact `link/1`.
    ///
    /// A CAPABILITY, never an identity and never a security input. The
    /// signalling relay sees every roster frame and can strip this (link mode is
    /// denied) or forge it (we offer a link to a peer that cannot answer — also
    /// only a denial). It can never put plaintext on the wire, because the
    /// session keys are derived through commit/reveal rather than negotiated
    /// from an announcement. Treat it as "what this peer says it can do", which
    /// is exactly what it is worth.
    public let supportsLink: Bool

    public init(id: String, name: String, label: String, supportsLink: Bool = false) {
        self.id = id
        self.name = name
        self.label = label
        self.supportsLink = supportsLink
    }
}

public enum LanDiscoveryState: Equatable {
    /// Not resident: the app is tearing down, or nothing has started it yet.
    case off
    /// The user turned receiving off. Truthful and sticky — nothing reconnects
    /// until they turn it back on.
    case paused
    /// Socket opening/open, no `welcome` yet — the roster cannot be trusted to
    /// exclude us, so nothing is listed.
    case connecting
    /// Joined the room: the roster is meaningful, though possibly empty.
    case joined
    /// The socket dropped and a bounded-backoff retry is scheduled. Not a
    /// terminal state: a resident app that stops retrying is an app that is
    /// silently no longer reachable.
    case reconnecting(String)
}

/// Notified when the room socket is replaced or lost.
///
/// The reason this is a protocol rather than the discovery model simply owning
/// the listener: reconnecting mints a *new* `SignalingClient` (and a new peer
/// id), so anything subscribed to inbound signals has to re-subscribe on every
/// socket. Handing that responsibility to an observer keeps the roster model
/// ignorant of what receiving is, and keeps exactly one socket in the room.
@MainActor
public protocol NearbyRoomObserver: AnyObject {
    /// A new socket is live. Any subscription to the previous one is already
    /// invalid; register again on this one.
    func roomDidConnect(_ signaling: SignalingClient)
    /// The socket is gone — dropped, paused or stopped.
    func roomDidDisconnect()
    /// The room's OTHER devices, as this model currently lists them.
    ///
    /// Representative presence, not physical-link authority: a device can leave
    /// this list because a handoff moved its advertised id to another of its
    /// connections. An observer may withdraw an ask to an id that vanished; it
    /// must not tear down a session on one.
    func roomRosterChanged(peerIds: Set<String>)
    /// The hub said one peer's signalling connection actually closed.
    ///
    /// The one signal that IS definitive permission to end what is bound to that
    /// id. Deliberately separate from the roster for exactly that reason.
    func roomPeerLeft(_ peerId: String)
}

public extension NearbyRoomObserver {
    /// Defaulted, because the observer this protocol was written for — the
    /// background-receive listener — has no use for either: it answers offers
    /// and owns no per-peer lifecycle. Only the link router does.
    func roomRosterChanged(peerIds: Set<String>) {}
    func roomPeerLeft(_ peerId: String) {}
}

/// Turns a raw room roster into the list the user picks from.
///
/// Pure and public because the rules that matter are here, and every one of
/// them is a way this feature can go wrong: excluding ourselves by id, never
/// inheriting the hub's ordering, and disambiguating duplicate names.
public func nearbyDevices(roster: [Peer],
                          selfId: String,
                          supportsLink: (String) -> Bool = { _ in false }) -> [NearbyDevice] {
    // The hub broadcasts the WHOLE room to every member, us included
    // (server/internal/signal/hub.go's broadcastRoster). Before `welcome`
    // there is no way to tell which entry is ours, so nothing is offered at
    // all rather than offering the user their own Mac to send to.
    guard !selfId.isEmpty else { return [] }

    var seen: Set<String> = []
    var unique: [(id: String, name: String)] = []
    for peer in roster where peer.id != selfId && !peer.id.isEmpty {
        guard seen.insert(peer.id).inserted else { continue }
        // Peer-supplied text rendered in our UI: strip bidi overrides and
        // control characters, the same treatment incoming file names get, so a
        // device cannot dress its name up as another one.
        let cleaned = safeDisplayName(peer.name)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        unique.append((peer.id, cleaned.isEmpty ? L10n.t(.nearbyUnnamedDevice) : cleaned))
    }

    var nameCounts: [String: Int] = [:]
    for device in unique { nameCounts[device.name, default: 0] += 1 }

    // The hub builds the roster by ranging a Go map, so its order differs
    // between broadcasts. Sorting is what stops the list from reshuffling
    // under the pointer between two roster frames — which, with selection
    // bound to a row's position rather than its id, is how the wrong device
    // gets picked.
    return unique
        .sorted { ($0.name, $0.id) < ($1.name, $1.id) }
        .map { device in
            let ambiguous = (nameCounts[device.name] ?? 0) > 1
            return NearbyDevice(
                id: device.id,
                name: device.name,
                label: ambiguous ? "\(device.name) · \(shortPeerID(device.id))" : device.name,
                supportsLink: supportsLink(device.id)
            )
        }
}

/// Enough of a peer id to tell two same-named devices apart on screen without
/// putting a full opaque id in front of the user.
func shortPeerID(_ id: String) -> String { String(id.suffix(6)) }

/// Joins the same-network rendezvous room, keeps the roster the user picks
/// from, and keeps that one socket alive for as long as the app is resident.
///
/// This is NOT Bonjour/mDNS and does not look at the local network at all: it
/// joins the hub's code-less room, which the server keys by the public IP it
/// observes. Devices behind the same NAT therefore see each other — and so, in
/// principle, does anything else sharing that address, which is why nothing
/// here ever selects a peer on the user's behalf.
///
/// Residency is why this model, and not the pane, owns the lifecycle: the room
/// membership is what makes this Mac reachable, so it has to outlive the window
/// (`MenuBarExtra` keeps the process up) and it has to survive a dropped socket.
/// Exactly one socket exists at a time — two would put this Mac in the room
/// twice, under two peer ids, and every other device would see it as two
/// devices.
@MainActor
public final class LanDiscoveryModel: ObservableObject {
    @Published public private(set) var state: LanDiscoveryState = .off
    @Published public private(set) var devices: [NearbyDevice] = []
    /// The peer id the user picked, or nil. Only ever set by `select`.
    @Published public private(set) var selectedId: String?

    /// The live room socket. Handed to `RealtimeConnectionFactory.connectNearby`
    /// so a transfer reuses the very socket the roster came from — reconnecting
    /// would earn a new peer id and a roster the user never saw.
    ///
    /// Not `@Published`: it is wiring, not view state, and republishing it
    /// would only invalidate views that must not depend on it.
    public private(set) var client: SignalingClient?

    /// Re-subscribed on every socket. Weak: the observer (the receive model)
    /// outlives individual sockets and must not be kept alive by this one.
    public weak var observer: NearbyRoomObserver?

    /// Everything else that has to re-subscribe on every socket.
    ///
    /// A SECOND registry rather than turning `observer` into a list, and the
    /// asymmetry is deliberate: background receive is the one observer whose
    /// interceptor must keep its existing position in the socket's routing
    /// order, because that order decides which router sees a legacy offer
    /// first. Everything added here is registered strictly after it, so adding
    /// an observer cannot reorder a shipped path.
    ///
    /// Weak, for the same reason `observer` is: `LinkWorkspaceModel` outlives
    /// individual sockets and must not be kept alive by one. Entries whose
    /// observer has gone are dropped on the next room edge rather than in a
    /// timer — the list has at most a couple of entries for the life of the
    /// process, so there is nothing to reclaim eagerly.
    private var additionalObservers: [WeakRoomObserver] = []

    private struct WeakRoomObserver {
        weak var value: NearbyRoomObserver?
    }

    /// Observe every socket this model opens, from now on.
    ///
    /// Idempotent by identity: registering the same object twice would give it
    /// two subscriptions on one socket, and the second one's interceptor would
    /// see frames the first had already consumed.
    ///
    /// It does NOT retroactively announce the socket that is already open. A
    /// caller that registers mid-room is told about the room on the next
    /// `roomDidConnect`, which is the same contract `observer` has always had —
    /// and the app registers both before residency starts.
    public func addRoomObserver(_ observer: NearbyRoomObserver) {
        additionalObservers.removeAll { $0.value == nil }
        guard !additionalObservers.contains(where: { $0.value === observer }) else { return }
        additionalObservers.append(WeakRoomObserver(value: observer))
    }

    /// The one place both registries are announced to, in one fixed order.
    private func announceRoomConnected(_ socket: SignalingClient) {
        observer?.roomDidConnect(socket)
        additionalObservers.removeAll { $0.value == nil }
        for entry in additionalObservers { entry.value?.roomDidConnect(socket) }
    }

    private func announceRoomDisconnected() {
        observer?.roomDidDisconnect()
        additionalObservers.removeAll { $0.value == nil }
        for entry in additionalObservers { entry.value?.roomDidDisconnect() }
    }

    private func announceRoster(_ peerIds: Set<String>) {
        observer?.roomRosterChanged(peerIds: peerIds)
        additionalObservers.removeAll { $0.value == nil }
        for entry in additionalObservers { entry.value?.roomRosterChanged(peerIds: peerIds) }
    }

    private func announcePeerLeft(_ peerId: String) {
        observer?.roomPeerLeft(peerId)
        additionalObservers.removeAll { $0.value == nil }
        for entry in additionalObservers { entry.value?.roomPeerLeft(peerId) }
    }

    /// What each peer in the room says it can speak.
    ///
    /// Owned HERE because its lifetime is the room's: a peer id only means
    /// something inside the room that issued it, and this model is the one thing
    /// that knows when a room ends. Exposed so the workspace layer reads the
    /// same announcements the roster was built from, rather than keeping a
    /// second copy that can disagree with what the user is looking at.
    public let capabilities = PeerCapabilityRegistry(
        // The code-less room IS this model — it joins the hub's room with an
        // empty code — so the room half of the predicate is constant here and
        // the build flag is the only thing that can turn it off.
        linkRoomActive: { linkRoomActive(isCodelessRoom: true) }
    )
    private lazy var announcer = LinkCapabilityAnnouncer(
        registry: capabilities,
        linkRoomActive: { linkRoomActive(isCodelessRoom: true) },
        send: { [weak self] peerId, signal in self?.client?.sendSignal(to: peerId, data: signal) }
    )

    public var selectedDevice: NearbyDevice? { devices.first { $0.id == selectedId } }

    /// A presentation-only snapshot for an admitted inbound offer. Peer ids are
    /// scoped to this room and device names are peer-supplied, so callers use
    /// the result only as a visible label and never as identity or routing.
    public func label(forPeerID peerID: String) -> String {
        devices.first { $0.id == peerID }?.label
            ?? "\(L10n.t(.nearbyUnnamedDevice)) · \(shortPeerID(peerID))"
    }
    /// A socket exists or is being opened. `reconnecting` is deliberately false:
    /// the roster is empty and unmaintained during the gap, and a UI that claims
    /// otherwise is showing devices that may not be there.
    public var isScanning: Bool {
        switch state {
        case .connecting, .joined: return true
        case .off, .paused, .reconnecting: return false
        }
    }

    public var isPaused: Bool { isPausedByUser }

    /// Bounded backoff. It stops growing rather than stopping altogether: the
    /// common cause is a network this Mac will rejoin (sleep, Wi-Fi change), and
    /// a listener that gives up permanently is a listener that silently stops
    /// receiving. One retry every 30 s against a rendezvous socket is not a load
    /// worth trading that for.
    static let reconnectBackoff: [TimeInterval] = [1, 2, 5, 10, 20, 30]

    private let connect: () -> SignalingClient
    private let sleep: @Sendable (UInt64) async -> Void
    private var roster: [Peer] = []
    private var selfId = ""
    /// Operation identity: a callback from a socket the user has stopped must
    /// not repopulate a roster they closed, and a retry timer armed for a socket
    /// epoch that has since been replaced must not open a second one. Same
    /// pattern as `RealtimeSessionModel.generation`.
    private var generation = 0
    private var isResident = false
    private var isPausedByUser = false
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    /// Records inbound capability hellos. A plain listener, never an
    /// interceptor: a hello must keep travelling to whatever else is listening,
    /// and this must not compete with the inbound-offer router for a frame.
    private var capsSubscription: SignalSubscription?
    private var capsRetryTask: Task<Void, Never>?

    /// Spacing between the bounded capability-hello retries. Short, because the
    /// whole point is to cover a hello lost to a socket that was still opening.
    static let capsRetryInterval: TimeInterval = 1.5

    public init(connect: @escaping () -> SignalingClient,
                // Optional rather than a defaulted closure literal — see
                // `realSleep`. `nil` means the real timer.
                sleep: (@Sendable (UInt64) async -> Void)? = nil) {
        self.connect = connect
        self.sleep = sleep ?? realSleep
    }

    /// Join the room and stay in it. Idempotent, and deliberately refuses to
    /// override an explicit pause — the app calls this on every launch and on
    /// every window that appears, and none of those is a decision to start
    /// receiving again.
    public func startResident() {
        guard !isResident else { return }
        isResident = true
        guard !isPausedByUser else {
            state = .paused
            return
        }
        reconnectAttempt = 0
        openSocket()
    }

    /// Join now, from a clean slate. Distinct from `startResident` in that it
    /// always reopens: the explicit "look again" action, and what the tests
    /// drive.
    public func start() {
        isResident = true
        isPausedByUser = false
        reconnectAttempt = 0
        openSocket()
    }

    /// The user turned receiving off. Sticky across reconnects and relaunched
    /// windows; only `resume` undoes it.
    public func pause() {
        guard !isPausedByUser else { return }
        isPausedByUser = true
        teardown()
        state = .paused
    }

    public func resume() {
        guard isPausedByUser else { return }
        isPausedByUser = false
        reconnectAttempt = 0
        guard isResident else {
            state = .off
            return
        }
        openSocket()
    }

    /// Leave the room and stay out of it. Not the pause the user sees — this is
    /// teardown.
    public func stop() {
        isResident = false
        teardown()
        state = .off
    }

    private func openSocket() {
        // `teardown` bumps the generation and closes any previous socket first,
        // so no path through here can end up with two live rooms.
        teardown()
        let g = generation
        state = .connecting
        let socket = connect()
        socket.onSelfId = { [weak self] id, _ in
            Task { @MainActor in
                self?.apply(g) { model in
                    model.selfId = id
                    model.state = .joined
                    // A join is what proves the retry worked; anything short of
                    // it and the next drop should not start from zero again.
                    model.reconnectAttempt = 0
                    model.refresh()
                }
            }
        }
        socket.onPeers = { [weak self] peers in
            Task { @MainActor in
                self?.apply(g) { model in
                    model.roster = peers
                    model.refresh()
                }
            }
        }
        socket.onClose = { [weak self] in
            Task { @MainActor in self?.apply(g) { $0.dropped() } }
        }
        // The hub's physical-departure frame, which nothing claimed before. It
        // is NOT derivable from `onPeers`: a representative handoff removes an
        // id from the roster while the device is still there, and ending a
        // session on that would be a bug. Forwarded rather than acted on here —
        // this model lists devices and owns no per-peer lifecycle.
        socket.onPeerLeft = { [weak self] peerId in
            Task { @MainActor in
                self?.apply(g) { model in model.announcePeerLeft(peerId) }
            }
        }
        // Registered before the observer's own subscription, and deliberately as
        // a listener rather than an interceptor: a capability hello is not this
        // model's to claim, it is only this model's to notice.
        capsSubscription = socket.addSignalListener { [weak self] from, data in
            Task { @MainActor in
                guard let self, g == self.generation else { return }
                guard self.capabilities.record(peerId: from, signal: data) else { return }
                // Only ever RETIRES retries. Answering a hello with a hello is
                // how two devices talk past each other forever.
                self.announcer.didHearFrom(peerId: from)
                self.refresh()
            }
        }
        client = socket
        // `teardown()` above has already ended the previous room for the
        // announcer, so this only has to arm the new one's retries.
        scheduleCapsRetries()
        announceRoomConnected(socket)
    }

    /// Bounded, and tied to this socket epoch. The hello is unacknowledged, so
    /// it repeats; it repeats a fixed number of times because a client that
    /// keeps talking to a peer that never answers is a client that never stops.
    private func scheduleCapsRetries() {
        capsRetryTask?.cancel()
        let g = generation
        let sleep = self.sleep
        capsRetryTask = Task { [weak self] in
            for _ in 0..<LINK_CAPS_ANNOUNCE_ATTEMPTS {
                await sleep(UInt64(Self.capsRetryInterval * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    guard let self, g == self.generation else { return }
                    self.announcer.retryTick()
                }
            }
        }
    }

    /// Everything that ends a socket epoch. Bumps first, so the `close()` below
    /// — which fires `onClose` synchronously on some channels — cannot be read
    /// as a drop worth reconnecting from.
    private func teardown() {
        generation += 1
        reconnectTask?.cancel()
        reconnectTask = nil
        capsRetryTask?.cancel()
        capsRetryTask = nil
        capsSubscription?.cancel()
        capsSubscription = nil
        // Discards every announcement with the room that issued the ids it
        // named. A peer id means nothing outside its own room.
        announcer.roomChanged()
        client?.close()
        client = nil
        announceRoomDisconnected()
        roster = []
        selfId = ""
        devices = []
        selectedId = nil
    }

    /// The user picked a row. Rejects anything that is not currently in the
    /// room — including our own id, which the roster always contains.
    public func select(_ id: String) {
        guard id != selfId, devices.contains(where: { $0.id == id }) else { return }
        selectedId = id
    }

    public func clearSelection() { selectedId = nil }

    private func refresh() {
        // `welcome` can land before this model's `onSelfId` is installed — the
        // socket stores the id for exactly that reason (see
        // `SignalingClient.selfId`). Without this fallback that race shows up
        // as a room that never lists anybody, because the roster arrives and
        // there is still no id to exclude ourselves by.
        if selfId.isEmpty, let known = client?.selfId, !known.isEmpty {
            selfId = known
            state = .joined
        }
        devices = nearbyDevices(roster: roster, selfId: selfId,
                                supportsLink: { [capabilities] in
                                    capabilities.supports($0, LINK_CAPABILITY)
                                })
        // Only once BOTH halves of a meaningful roster exist.
        //
        // `devices` is empty by construction until `welcome` gives us an id to
        // exclude ourselves by AND a `peers` frame has arrived — and those are
        // two independent frames on one socket, in either order. Handing that
        // empty list to the announcer retains nothing, which discards a hello
        // that arrived ahead of it: a peer already in the room announces the
        // instant it sees us join, so this is the ordinary case rather than a
        // rare one. The peer's own bounded retries would eventually repair it,
        // which is what made this survivable, but it threw away an announcement
        // already correctly received.
        //
        // The hub always includes us in the roster it broadcasts, so a non-empty
        // `roster` is exactly "a roster has been delivered".
        //
        // Greeting is driven by the roster gaining a peer, never by hearing from
        // one — see `LinkCapabilityAnnouncer`. Departed peers are dropped from
        // the registry in the same call.
        if !selfId.isEmpty, !roster.isEmpty {
            let peerIds = devices.map(\.id)
            announcer.rosterChanged(peerIds: peerIds)
            announceRoster(Set(peerIds))
        }
        // A device that left must not leave a selection pointing at nothing:
        // the next Send would dial a peer id the room no longer contains, and
        // the id could by then belong to a different device entirely.
        if let id = selectedId, !devices.contains(where: { $0.id == id }) {
            selectedId = nil
        }
    }

    private func dropped() {
        // Bump first: nothing from the dead socket may repaint this, and the
        // retry armed below is identified by the epoch that follows.
        generation += 1
        reconnectTask?.cancel()
        reconnectTask = nil
        capsRetryTask?.cancel()
        capsRetryTask = nil
        capsSubscription?.cancel()
        capsSubscription = nil
        announcer.roomChanged()
        client = nil
        announceRoomDisconnected()
        roster = []
        selfId = ""
        devices = []
        selectedId = nil
        guard isResident, !isPausedByUser else {
            state = isPausedByUser ? .paused : .off
            return
        }
        state = .reconnecting(L10n.t(.nearbyReconnecting))
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        let index = min(reconnectAttempt, Self.reconnectBackoff.count - 1)
        let delay = Self.reconnectBackoff[index]
        reconnectAttempt += 1
        let g = generation
        let sleep = self.sleep
        reconnectTask = Task { [weak self] in
            await sleep(UInt64(max(0, delay) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self else { return }
                // A stale timer: the epoch it was armed for has been replaced by
                // a stop, a pause, or a manual restart that already reopened.
                guard g == self.generation, self.isResident, !self.isPausedByUser else { return }
                // Cleared before `openSocket`, whose `teardown` would otherwise
                // cancel the very task running this line.
                self.reconnectTask = nil
                self.openSocket()
            }
        }
    }

    private func apply(_ g: Int, _ body: (LanDiscoveryModel) -> Void) {
        guard g == generation else { return }
        body(self)
    }
}
