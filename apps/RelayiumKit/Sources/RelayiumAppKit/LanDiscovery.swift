import Foundation
import RelayiumKit

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

    public init(id: String, name: String, label: String) {
        self.id = id
        self.name = name
        self.label = label
    }
}

public enum LanDiscoveryState: Equatable {
    case off
    /// Socket opening/open, no `welcome` yet — the roster cannot be trusted to
    /// exclude us, so nothing is listed.
    case scanning
    /// Joined the room: the roster is meaningful, though possibly empty.
    case joined
    case failed(String)
}

/// Turns a raw room roster into the list the user picks from.
///
/// Pure and public because the rules that matter are here, and every one of
/// them is a way this feature can go wrong: excluding ourselves by id, never
/// inheriting the hub's ordering, and disambiguating duplicate names.
public func nearbyDevices(roster: [Peer], selfId: String) -> [NearbyDevice] {
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
        unique.append((peer.id, cleaned.isEmpty ? "Unnamed device" : cleaned))
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
                label: ambiguous ? "\(device.name) · \(shortPeerID(device.id))" : device.name
            )
        }
}

/// Enough of a peer id to tell two same-named devices apart on screen without
/// putting a full opaque id in front of the user.
func shortPeerID(_ id: String) -> String { String(id.suffix(6)) }

/// Joins the same-network rendezvous room and keeps the roster the user picks
/// from.
///
/// This is NOT Bonjour/mDNS and does not look at the local network at all: it
/// joins the hub's code-less room, which the server keys by the public IP it
/// observes. Devices behind the same NAT therefore see each other — and so, in
/// principle, does anything else sharing that address, which is why nothing
/// here ever selects a peer on the user's behalf.
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

    public var selectedDevice: NearbyDevice? { devices.first { $0.id == selectedId } }
    public var isScanning: Bool {
        switch state {
        case .scanning, .joined: return true
        case .off, .failed: return false
        }
    }

    private let connect: () -> SignalingClient
    private var roster: [Peer] = []
    private var selfId = ""
    /// Operation identity: a callback from a socket the user has stopped must
    /// not repopulate a roster they closed. Same pattern as
    /// `RealtimeSessionModel.generation`.
    private var generation = 0

    public init(connect: @escaping () -> SignalingClient) {
        self.connect = connect
    }

    public func start() {
        // Also the reset: `stop` bumps the generation and closes any previous
        // socket, so a second Scan cannot end up with two live rooms.
        stop()
        let g = generation
        state = .scanning
        let socket = connect()
        socket.onSelfId = { [weak self] id, _ in
            Task { @MainActor in
                self?.apply(g) { model in
                    model.selfId = id
                    model.state = .joined
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
        client = socket
    }

    public func stop() {
        generation += 1
        client?.close()
        client = nil
        roster = []
        selfId = ""
        devices = []
        selectedId = nil
        state = .off
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
        devices = nearbyDevices(roster: roster, selfId: selfId)
        // A device that left must not leave a selection pointing at nothing:
        // the next Send would dial a peer id the room no longer contains, and
        // the id could by then belong to a different device entirely.
        if let id = selectedId, !devices.contains(where: { $0.id == id }) {
            selectedId = nil
        }
    }

    private func dropped() {
        // Bump first: nothing from the dead socket may repaint this.
        generation += 1
        client = nil
        roster = []
        selfId = ""
        devices = []
        selectedId = nil
        state = .failed("Lost the connection to Relayium's device rendezvous. Scan again.")
    }

    private func apply(_ g: Int, _ body: (LanDiscoveryModel) -> Void) {
        guard g == generation else { return }
        body(self)
    }
}
