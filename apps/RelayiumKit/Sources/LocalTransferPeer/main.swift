import Combine
import Foundation
import RelayiumAppKit
import RelayiumKit
// The local link's own discovery, reachable from this harness executable only.
import RelayiumLocalPeerKit
import RelayiumPeerKit

// The acceptance peer.
//
// One binary, four roles, and a loopback control API the launcher drives. It
// exists because XCUITest can drive exactly ONE app, so the second endpoint of
// any real transfer has to be a separate process — and because a transfer that
// "completed" is worth nothing as evidence unless both ends can state, in
// digests, what they believe passed between them.
//
//   LocalTransferPeer --role nearby-receiver --origin http://127.0.0.1:P \
//                     --name <room name> --receive-root <dir> --run-tag <tag>
//   LocalTransferPeer --role nearby-sender   --origin ... --name ... \
//                     --counterpart <name> --run-tag <tag>
//   LocalTransferPeer --role local-link-peer --origin ... --name <link name> \
//                     --receive-root <dir> --run-tag <tag>
//   LocalTransferPeer --role pair-sender     --origin ... --receive-root ... --run-tag ...
//   LocalTransferPeer --role pair-receiver   --origin ... --receive-root ... --run-tag ...
//   LocalTransferPeer --role inbox-endpoint  --origin ... --state-root <dir> --run-tag <tag>
//
// Secrets arrive in the ENVIRONMENT and never in argv:
//   RELAYIUM_ACCEPTANCE_CONTROL_TOKEN   the control API bearer (required)
//   RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN   the account bearer a mint needs
//                                       (pair-sender only)
// argv on macOS is readable by every process this user runs, so a token there
// would be published to the whole session for the life of the run.

func log(_ message: String) {
    FileHandle.standardError.write(Data("[\(Date())] \(message)\n".utf8))
}

func fail(_ message: String) -> Never {
    log("fatal: \(message)")
    exit(2)
}

// MARK: - arguments

let rawArguments = Array(CommandLine.arguments.dropFirst())

func option(_ name: String) -> String? {
    guard let flag = rawArguments.firstIndex(of: name) else { return nil }
    let value = rawArguments.index(after: flag)
    guard value < rawArguments.endIndex else { fail("\(name) needs a value") }
    return rawArguments[value]
}

func require(_ name: String) -> String {
    guard let value = option(name), !value.isEmpty else { fail("\(name) is required") }
    return value
}

enum Role: String {
    case nearbyReceiver = "nearby-receiver"
    case nearbySender = "nearby-sender"
    /// Nearby on the link itself, which is the only rendezvous shipped iOS
    /// has. `nearby-receiver` above joins the hub's code-less room, which is
    /// still right for macOS. See `LocalLinkPeerRun`.
    case localLinkPeer = "local-link-peer"
    case pairSender = "pair-sender"
    case pairReceiver = "pair-receiver"
    /// The `link/1` pairing surface, which is a different wire from the two
    /// above: `AppPairHost` drives the LEGACY code room, and nothing here could
    /// stand a real macOS link pairing room up against a second endpoint until
    /// this role existed. See `AppPairLinkHost`.
    case pairLink = "pair-link"
    /// The two halves of a **Device Inbox** delivery, which is not a peer-to-peer
    /// wire at all: the sender seals the content key to the target device's
    /// current public key, uploads the ciphertext, and central holds the task
    /// until the target claims it. Two roles rather than one driven role,
    /// because the whole point is that two SEPARATE macOS processes complete it.
    case inboxSender = "inbox-sender"
    case inboxReceiver = "inbox-receiver"
    /// **A whole Device Inbox endpoint**: the receiving half and the sending
    /// half in one process, over one durable state root, with the same three
    /// seams `RelayiumApp` uses to join them. The two roles above each own one
    /// half and hold no conversation index, so nothing built from them can
    /// observe a sent row, a local deletion or a history that survives a
    /// restart — which is the whole 1.2.11 contract. See `InboxEndpointRun`.
    case inboxEndpoint = "inbox-endpoint"
}

/// The launch configuration, resolved once.
///
/// A namespace rather than top-level `let`s because the run classes below close
/// over it, and Swift will not let a type capture a top-level binding in
/// `main.swift` — it is local to the implicit main function, however global it
/// looks.
enum Config {
    static let role: Role = {
        guard let role = Role(rawValue: require("--role")) else {
            fail("--role must be one of nearby-receiver, nearby-sender, "
                 + "local-link-peer, pair-sender, pair-receiver, pair-link, "
                 + "inbox-sender, inbox-receiver, inbox-endpoint")
        }
        return role
    }()

    /// **Validated by the product's own seam, not by a second parser here.**
    ///
    /// If this had its own idea of what "loopback" means, an acceptance run
    /// could pass against an origin the app itself would refuse — which would
    /// make the suite evidence about this file rather than about the shipped
    /// rule. Reusing `AppEnvironment.loopbackTransferOrigin` means the peer
    /// physically cannot address anything the app would not.
    static let origin: URL = {
        let raw = require("--origin")
        guard let origin = AppEnvironment.loopbackTransferOrigin(raw) else {
            fail("--origin \(raw) is not a loopback origin the app would accept")
        }
        return origin
    }()

    static let runTag = require("--run-tag")

    /// Secrets arrive in the environment, never in argv: argv on macOS is
    /// readable by every process this user runs.
    static let controlToken: String = {
        let token = ProcessInfo.processInfo
            .environment["RELAYIUM_ACCEPTANCE_CONTROL_TOKEN"] ?? ""
        guard !token.isEmpty else {
            fail("RELAYIUM_ACCEPTANCE_CONTROL_TOKEN must be set in the environment")
        }
        return token
    }()

    static let receiveRoot: URL? = option("--receive-root").map { URL(fileURLWithPath: $0) }

    /// The ONE durable root a bidirectional endpoint owns: received files, the
    /// files it sends, the pending-upload staging area and every account-scoped
    /// store beneath it.
    ///
    /// Separate from `--receive-root` because it is a different promise. A
    /// receive root is where files land; this is the whole of what an endpoint
    /// must find again after it is torn down and rebuilt, which is exactly what
    /// a no-resurrection claim rests on. A launcher restarts an endpoint by
    /// starting a NEW process against the SAME value.
    static let stateRoot: URL? = option("--state-root").map { URL(fileURLWithPath: $0) }
}

let role = Config.role
let origin = Config.origin
let runTag = Config.runTag
let controlToken = Config.controlToken

extension Config {
    static let batch = AcceptanceBatch.make(runTag: runTag)
    static let sentReceipts = AcceptanceBatch.receipts(for: batch)
}

let batch = Config.batch
let sentReceipts = Config.sentReceipts

// MARK: - shared state

final class State: @unchecked Sendable {
    private let lock = NSLock()
    private var _phase = "idle"
    private var _detail: [String: String] = [:]
    private var _receipts: [FileReceipt] = []
    private var _failure: String?

    var phase: String { lock.lock(); defer { lock.unlock() }; return _phase }
    var failure: String? { lock.lock(); defer { lock.unlock() }; return _failure }

    func set(phase: String) {
        lock.lock(); _phase = phase; lock.unlock()
        log("phase: \(phase)")
    }

    func set(_ key: String, _ value: String) {
        lock.lock(); _detail[key] = value; lock.unlock()
    }

    func detail(_ key: String) -> String? {
        lock.lock(); defer { lock.unlock() }; return _detail[key]
    }

    func finish(receipts: [FileReceipt]) {
        lock.lock(); _receipts = receipts; _phase = "done"; lock.unlock()
        log("phase: done with \(receipts.count) receipt(s)")
    }

    func failed(_ reason: String) {
        lock.lock()
        if _failure == nil { _failure = reason; _phase = "failed" }
        lock.unlock()
        log("phase: failed — \(reason)")
    }

    func snapshot() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        var out: [String: Any] = ["phase": _phase, "role": Config.role.rawValue,
                                  "origin": Config.origin.absoluteString,
                                  "runTag": Config.runTag]
        for (key, value) in _detail { out[key] = value }
        if let _failure { out["failure"] = _failure }
        return out
    }

    func result() -> [String: Any] {
        lock.lock()
        let receipts = _receipts
        let phase = _phase
        let failure = _failure
        lock.unlock()
        var out: [String: Any] = [
            "phase": phase,
            "role": Config.role.rawValue,
            // The origin this process actually resolved, echoed back so the
            // launcher's assertion that the run was local is made against the
            // peer's own answer rather than against the string it passed in.
            "origin": Config.origin.absoluteString,
            "files": receipts.map { receipt -> [String: Any] in
                var entry: [String: Any] = ["name": receipt.name,
                                            "size": receipt.size,
                                            "sha256": receipt.sha256]
                if let path = receipt.path { entry["path"] = path }
                return entry
            },
        ]
        if let failure { out["failure"] = failure }
        return out
    }
}

let state = State()

func json(_ value: [String: Any], status: Int = 200) -> (status: Int, body: Data) {
    let data = (try? JSONSerialization.data(withJSONObject: value,
                                            options: [.sortedKeys]))
        ?? Data(#"{"error":"unencodable"}"#.utf8)
    return (status, data)
}

// MARK: - the roles

/// Nearby, receiving: the app's own machinery, resident, answering an offer
/// nobody there accepted.
///
/// **Two wires, one host.** A counterpart that never announced `link/1` reaches
/// the legacy nearby machinery; one that did reaches the link workspace. Which
/// arrives is decided by the peer before anybody dials, so this waits on both
/// and finishes on whichever produced a committed result. T2a's `PlainPeer`
/// drives the first; a built App drives the second.
@MainActor final class NearbyReceiverRun {
    let host: AppReceiverHost

    /// How long a run may wait with NOTHING having arrived.
    ///
    /// Deliberately measured from the last observed progress rather than from
    /// `start`, because the two callers have very different clocks: T2a dials
    /// within a second of `/start`, while a UI acceptance run has to boot a
    /// simulator, launch an app and drive a roster first. Extending a fixed
    /// ceiling to cover the slower caller would have weakened the faster one's
    /// stall detection; resetting it on real progress covers both without
    /// either waiting on the other's worst case.
    static let idleCeiling: TimeInterval = 240

    init(receiveRoot: URL, name: String) throws {
        host = try AppReceiverHost(options: .init(
            baseURL: Config.origin, name: name, receiveRoot: receiveRoot,
            defaultsSuite: "com.relayium.acceptance.\(Config.runTag)"))
        // Every link transition this side sees, in this peer's own log — which
        // a failed run retains and prints. A UI run's app is gone by the time
        // anybody reads the failure, so this is the only surviving account of
        // what the second endpoint actually did.
        host.linkCounterpart.logEvent = { log($0) }
    }

    func start() {
        host.start()
        state.set(phase: "resident")
        Task { @MainActor in
            var lastProgress = Date()
            var seen = ""
            while Date().timeIntervalSince(lastProgress) < Self.idleCeiling {
                if case .completed = host.fileModel.state {
                    state.finish(receipts: host.receipts())
                    return
                }
                if case let .failed(message) = host.fileModel.state {
                    return state.failed("legacy receive failed: \(message)")
                }
                // The link's own committed state. `received` is the only inbound
                // state that means bytes are on disk — `finished` is a report
                // this projection has seen no proof of, and its own doc says so.
                if let files = host.link.fileModel?.batches,
                   files.contains(where: { batch in
                       guard batch.direction == .inbound else { return false }
                       if case .received = batch.state { return true }
                       return false
                   }) {
                    state.finish(receipts: host.receipts())
                    return
                }
                // Any observable movement resets the stall clock — a link that is
                // establishing, digits that arrived, a message, a batch in
                // flight. An ORDERED fingerprint, not the fact dictionary's
                // `description`: a `[String: Any]` has no stable ordering, so
                // comparing two descriptions of identical state would report
                // progress at random and this ceiling would never fire.
                let progress = linkProgressFingerprint(host: host)
                if progress != seen {
                    seen = progress
                    lastProgress = Date()
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            state.failed("nothing arrived for \(Int(Self.idleCeiling))s: "
                         + linkProgressFingerprint(host: host))
        }
    }

    func teardown() { host.teardown() }
}

/// What a link-serving role can be asked about its link.
///
/// A protocol rather than a concrete host because two compositions now serve a
/// real `link/1` — one in the hub's code-less room (`AppReceiverHost`), one on
/// the local link (`LocalLinkPeerHost`) — and the launcher, the UI suite and the
/// stall watchdog must read the same facts from either. Every member is already
/// `AppReceiverHost`'s own public surface, so the conformance adds nothing.
@MainActor
protocol LinkObserving: AnyObject {
    var link: LinkWorkspaceModel { get }
    func receipts() -> [FileReceipt]
    func allReceipts() -> [FileReceipt]
    func receivedMessages() -> [String]
    func allMessages() -> [String]
    func linkSAS() -> String?
    func linkEpoch() -> Int
}

extension AppReceiverHost: LinkObserving {}

/// An ordered, stable rendering of everything about this link that can move.
///
/// Its only job is "did anything change since the last look", so it is built
/// from a fixed sequence of fields rather than from a dictionary. It is also
/// what a stalled run prints, which is why it names the phase and the batch
/// states rather than reducing them to a count.
@MainActor
func linkProgressFingerprint(host: some LinkObserving) -> String {
    let batches = (host.link.fileModel?.batches ?? [])
        .map { "\($0.direction):\($0.state):\($0.transferredBytes)" }
        .joined(separator: ",")
    return "phase=\(host.link.connection)"
        + " epoch=\(host.linkEpoch())"
        + " sas=\(host.linkSAS() ?? "-")"
        + " messages=\(host.receivedMessages().count)"
        + " batches=[\(batches)]"
}

/// The live link view a UI acceptance run polls.
///
/// Separate from `/status` and `/result` on purpose: those two carry T2a's
/// contract, which is a fixed batch and a terminal `done`, and a UI run has
/// neither — it decides for itself when the file and the message it drove have
/// both arrived. Nothing here is derived: every value is read off the model the
/// production writer filled in.
@MainActor
func liveLinkFacts(host: some LinkObserving) -> [String: Any] {
    func entries(_ receipts: [FileReceipt]) -> [[String: Any]] {
        receipts.map { receipt in
            var entry: [String: Any] = ["name": receipt.name, "size": receipt.size,
                                        "sha256": receipt.sha256]
            if let path = receipt.path { entry["path"] = path }
            return entry
        }
    }
    var out: [String: Any] = [
        "linkPhase": String(describing: host.link.connection),
        // **Which link these facts belong to.** A caller polling "has a SAS
        // arrived" has to be able to tell this link's digits from the previous
        // link's, because a resident counterpart serves several in one run and
        // the first version of this view could not — it answered a later poll
        // with an earlier link's residue and passed a test that had established
        // nothing.
        "epoch": host.linkEpoch(),
        "messages": host.receivedMessages(),
        "files": entries(host.receipts()),
        // Cumulative, across every link this process served. What a launcher
        // reads after the app has gone and the live link has been dismissed.
        "allMessages": host.allMessages(),
        "allFiles": entries(host.allReceipts()),
    ]
    if let sas = host.linkSAS() { out["sas"] = sas }
    if let batches = host.link.fileModel?.batches {
        out["batchStates"] = batches.map { "\($0.direction):\($0.state)" }
    }
    return out
}

// MARK: - Nearby, on the local link

/// The second endpoint of an iOS Nearby link: a real `_relayium._tcp` peer on
/// the same link rather than a resident in a room on a server.
///
/// `nearby-receiver` joins the hub's code-less room, which is still where macOS
/// discovery looks. Shipped iOS composes its roster through
/// `LocalNearbyEnvironment`, so it browses and advertises one Bonjour service
/// and joins no room at all: a counterpart in the hub's room is not a device on
/// its link, and the app truthfully renders an empty roster against one.
///
/// The capabilities, the transport, the channel and the link surface are the
/// product's own, so this peer cannot announce a wire the app would refuse and
/// every receipt it reports is read off the model a production writer filled in.
/// Only the advertised NAME is composed here rather than taken from
/// `LocalNearbyEnvironment.makeDiscoveryModel()`, which uses
/// `AppEnvironment.deviceName()` — one constant string per machine, and unusable
/// for a roster assertion that has to name this run on a shared build agent. The
/// rest of that composition is repeated verbatim, including arming the channel
/// in `activate`: a local transport can be ready synchronously and would
/// otherwise announce a roster into callbacks `LanDiscoveryModel` has not
/// installed yet.
@MainActor final class LocalLinkPeerHost: LinkObserving {

    /// Published on `/status`, so a failing run can say what it advertised
    /// rather than leaving that to be inferred from a roster that never named it.
    let advertisement: LocalPeerAdvertisement
    let discovery: LanDiscoveryModel
    /// Retained because `LanDiscoveryModel.observer` is weak. It answers a
    /// legacy offer with the tagged `busy` this build's peers understand, rather
    /// than leaving one to wait out its own timeout in silence.
    let receive: NearbyReceiveModel
    let link: LinkWorkspaceModel
    let counterpart: LinkCounterpart

    private let receiveRoot: URL
    private let defaults: UserDefaults
    private let defaultsSuite: String

    init(name: String, receiveRoot: URL) throws {
        try FileManager.default.createDirectory(at: receiveRoot,
                                                withIntermediateDirectories: true)
        self.receiveRoot = receiveRoot
        // Scoped by role as well as run tag: this run starts a second peer
        // process, and two processes sharing a defaults domain would erase each
        // other's on teardown.
        defaultsSuite = "com.relayium.acceptance.\(Config.runTag).\(Config.role.rawValue)"
        guard let defaults = UserDefaults(suiteName: defaultsSuite) else {
            throw AppReceiverHost.HostError.unusableDefaultsSuite(defaultsSuite)
        }
        self.defaults = defaults
        // The shipped default is verification OFF, read from a throwaway domain
        // so the run does not inherit whatever the person running it chose.
        let verification = VerificationPreference(defaults: defaults)

        advertisement = LocalPeerAdvertisement(
            identity: LocalPeerAdvertisement.mintIdentity(),
            name: name,
            capabilities: LocalNearbyEnvironment.advertisedCapabilities)
        let advertisement = self.advertisement
        discovery = LanDiscoveryModel(prepare: {
            let channel = LocalPeerSignalingChannel(
                advertisement: advertisement,
                // The shipped transport, taking the same Debug-only same-host
                // seam the gated test App takes: both endpoints of this
                // acceptance are on one Mac, so a connection addressed through
                // the host's own Wi-Fi address can still be classified as
                // loopback, which the shipped default prohibits. Either side
                // may listen or dial, so both opt in.
                //
                // It permits that route and nothing else. The advertisement,
                // the name-based dial, the framing and the link surface are all
                // still the product's, and `includePeerToPeer` stays false.
                // `LocalNearbyModuleBoundaryTests` rejects a Release or ordinary
                // shipped construction that opts in; the app's own Debug factory
                // names it by design, behind the acceptance gate.
                transport: NetworkLocalPeerTransport(sameHostAcceptanceAllowsLoopback: true))
            let client = SignalingClient(channel: channel, name: advertisement.name)
            return PreparedNearbyConnection(client: client,
                                            activate: { channel.begin() })
        })

        receive = AppEnvironment.makeListeningOnlyNearbyReceiveModel(
            discovery: discovery, inboundRoom: InboundRoom())

        // Passed explicitly and never allowed to default, for the reason
        // `AppReceiverHost` records: the macOS overload defaults to the user's
        // Downloads folder, and this fixture writes only inside the run root.
        let root = receiveRoot
        link = AppEnvironment.makeLinkWorkspaceModel(
            baseURL: Config.origin, verification: verification, nearby: discovery,
            // No code is watched on this path, exactly as for the nearby host.
            pairingRoom: LinkRoomHandle(),
            receiveDirectory: { root })
        counterpart = LinkCounterpart(link: link)
    }

    /// Headless answers before advertising, for the reason `AppReceiverHost
    /// .start` gives: a peer can dial the instant the listener is ready, and an
    /// admission gate installed afterwards would race the first offer.
    func start() {
        counterpart.start()
        discovery.startResident()
    }

    func teardown() {
        link.leave()
        discovery.stop()
        defaults.removePersistentDomain(forName: defaultsSuite)
        try? FileManager.default.removeItem(at: receiveRoot)
    }

    /// Only the link's receipts, which is the honest total: this composition
    /// has no legacy transport to have written anything else.
    func receipts() -> [FileReceipt] { counterpart.receipts() }
    func allReceipts() -> [FileReceipt] { counterpart.allReceipts() }
    func receivedMessages() -> [String] { counterpart.current.messages }
    func allMessages() -> [String] { counterpart.allMessages() }
    func linkSAS() -> String? { counterpart.current.sas }
    func linkEpoch() -> Int { counterpart.current.epoch }
}

/// The `local-link-peer` role: advertise, then serve every link the app opens.
@MainActor final class LocalLinkPeerRun {
    let host: LocalLinkPeerHost

    /// From the last observed progress rather than from `start`, for the reason
    /// `NearbyReceiverRun.idleCeiling` records: a UI run boots a simulator and
    /// drives a roster before anything here can be observed.
    static let idleCeiling: TimeInterval = 240

    init(receiveRoot: URL, name: String) throws {
        host = try LocalLinkPeerHost(name: name, receiveRoot: receiveRoot)
        // Every link transition this side sees. A UI run's app is gone by the
        // time anybody reads the failure, so this is the surviving account.
        host.counterpart.logEvent = { log($0) }
    }

    func start() {
        host.start()
        state.set(phase: "advertising")
        Task { @MainActor in
            var lastProgress = Date()
            var seen = ""
            var lastRoster = ""
            var announced = false
            while true {
                let room = String(describing: host.discovery.state)
                // `joined` is a real readiness edge: the lifecycle announces
                // it only once the listener and the browser are both ready, so
                // the Bonjour service is registered and the browse is running.
                // Its own phase, so the launcher can refuse to spend a simulator
                // boot on a host where the service never came up.
                if !announced, case .joined = host.discovery.state {
                    announced = true
                    state.set("peerName", host.advertisement.name)
                    state.set("peerIdentity", host.advertisement.identity)
                    state.set(phase: "resident")
                    lastProgress = Date()
                }
                // The link's own committed state, and the same `received`-only
                // rule the nearby host uses: `finished` is a report this
                // projection has seen no proof of.
                if let batches = host.link.fileModel?.batches,
                   batches.contains(where: { batch in
                       guard batch.direction == .inbound else { return false }
                       if case .received = batch.state { return true }
                       return false
                   }) {
                    state.finish(receipts: host.receipts())
                    return
                }
                // This peer's own view, beside the app's. Discovery is
                // symmetric and its halves fail separately: an inbound offer
                // from a device this side has not discovered is held and then
                // dropped at `LocalPeerSignalingChannel.inboundGracePeriod`,
                // which without this reads exactly like a dial that never came.
                let roster = host.discovery.devices
                    .map { "\($0.name)/\($0.supportsLink ? "link" : "legacy")" }
                    .sorted().joined(separator: ",")
                let progress = "room=\(room) roster=[\(roster)] "
                    + linkProgressFingerprint(host: host)
                if progress != seen {
                    seen = progress
                    state.set("room", room)
                    state.set("roster", roster)
                    lastProgress = Date()
                }
                // Logged on change, with a timestamp: a failed run has to
                // answer when this side learned about the app relative to when
                // the app dialled, and a status field holds only the last answer.
                if roster != lastRoster {
                    lastRoster = roster
                    log("roster: [\(roster)]")
                }
                guard Date().timeIntervalSince(lastProgress) < Self.idleCeiling else {
                    return state.failed(
                        "nothing moved for \(Int(Self.idleCeiling))s: " + progress)
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }

    /// The live view, plus this side's own roster.
    ///
    /// Discovery is symmetric and its halves complete at different times: the
    /// app lists a peer that was already advertising almost at once, while this
    /// side has to be told about a service the Simulator registers afterwards.
    /// `LocalPeerSignalingChannel.inboundGracePeriod` is five seconds, so an app
    /// that dials as soon as its own roster fills can reach a counterpart that
    /// is still blind. Published so the suite can wait for the second half
    /// rather than race it; `supportsLink` comes from the credit this side gave
    /// the app's TXT record, so waiting on it waits for a real announcement.
    @MainActor
    func observed() -> [String: Any] {
        var facts = liveLinkFacts(host: host)
        facts["roster"] = host.discovery.devices.map {
            ["id": $0.id, "name": $0.name, "supportsLink": $0.supportsLink]
        }
        return facts
    }

    func teardown() { host.teardown() }
}

/// Nearby, sending: a plain peer that dials the resident receiver by name.
final class NearbySenderRun: @unchecked Sendable {
    let peer: PlainPeer
    let counterpart: String

    init(name: String, counterpart: String) {
        self.counterpart = counterpart
        peer = PlainPeer(options: .init(
            baseURL: Config.origin, code: "", name: name,
            // **Empty, and that is the acceptance property.** Peers on one
            // machine pair on host candidates; a public STUN entry here would
            // send this machine's address to a third party on every run and
            // make an offline run depend on the internet.
            iceServers: [],
            log: { log($0) }))
    }

    func start() {
        Task {
            guard let peerId = await peer.awaitPeer(named: counterpart, timeout: 45) else {
                return state.failed("\(counterpart) never appeared in the code-less room")
            }
            state.set(phase: "offering")
            var handlers = PlainPeer.Handlers()
            handlers.onOpen = { [self] connection in
                peer.send(Config.batch, on: connection)
            }
            handlers.onControl = { control in
                // CTRL_COMPLETE is sent by the receiver only after its writer
                // finished and the batch verified, so this — not "we called
                // send()" — is the sending side's evidence that the far side
                // really wrote the bytes.
                guard control == .complete else { return }
                state.finish(receipts: Config.sentReceipts)
            }
            handlers.onError = { state.failed("sender: \($0)") }
            peer.connect(to: peerId, role: .initiator, handlers: handlers)
            state.set(phase: "connecting")
        }
    }

    func teardown() { peer.close() }
}

/// Pairing, sending: the app's own model mints a real code on the local server
/// and dials the peer that joins it.
@MainActor final class PairSenderRun {
    let host: AppPairHost
    init(receiveRoot: URL) throws {
        host = try AppPairHost(options: .init(
            baseURL: Config.origin, receiveRoot: receiveRoot,
            defaultsSuite: "com.relayium.acceptance.\(Config.runTag)"))
    }

    func start() {
        let bearer = ProcessInfo.processInfo
            .environment["RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN"] ?? ""
        guard !bearer.isEmpty else {
            return state.failed("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN is required to mint a code")
        }
        Task { @MainActor in
            // Staged BEFORE the code exists, exactly as the transfer surface
            // does it: `proceedAfterVerification` sends whatever is pending once
            // the handshake completes, and a selection staged afterwards would
            // race that.
            host.model.stageSend(
                sources: Config.batch.map {
                    DataSource(name: $0.meta.name, bytes: $0.bytes) as PlaintextSource
                },
                metas: Config.batch.map(\.meta))
            state.set(phase: "minting")
            await host.model.mintCode(token: bearer)
            guard case let .showingCode(code, _) = host.model.state else {
                return state.failed("mint did not produce a code: \(host.model.state)")
            }
            // Published for the launcher to hand to the joiner. A pairing code
            // is short-lived, single-use and useless without a peer on the same
            // hub — and this hub is bound to loopback.
            state.set("code", code)
            state.set(phase: "showing-code")
            await host.model.join(code: code, role: .initiator)
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline {
                if case .completed = host.model.state {
                    // The SENDER's completed state carries no received files;
                    // what it can state is what it handed over.
                    state.finish(receipts: Config.sentReceipts)
                    return
                }
                if case let .failed(message) = host.model.state {
                    return state.failed("pair send failed: \(message)")
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            state.failed("timed out sending over the pairing code")
        }
    }

    func teardown() { host.teardown() }
}

/// Pairing, receiving: the app's own model joins a code somebody typed.
@MainActor final class PairReceiverRun {
    let host: AppPairHost
    init(receiveRoot: URL) throws {
        host = try AppPairHost(options: .init(
            baseURL: Config.origin, receiveRoot: receiveRoot,
            defaultsSuite: "com.relayium.acceptance.\(Config.runTag)"))
    }

    func start(code: String) {
        guard isCompletePairingCode(code) else {
            return state.failed("not a pairing code: \(code)")
        }
        Task { @MainActor in
            state.set(phase: "joining")
            await host.model.join(code: code, role: .responder)
            let deadline = Date().addingTimeInterval(120)
            while Date() < deadline {
                if case .completed = host.model.state {
                    state.finish(receipts: host.receipts())
                    return
                }
                if case let .failed(message) = host.model.state {
                    return state.failed("pair receive failed: \(message)")
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            state.failed("timed out receiving over the pairing code")
        }
    }

    func teardown() { host.teardown() }
}

/// Pairing over `link/1`: the app's own unified workspace on a real code.
///
/// **Driven rather than scripted.** The other pair roles run to a fixed batch
/// and a terminal `done`; this one is polled and told what to do, because the
/// counterpart is a browser whose own timing the launcher owns. What it must
/// never do is answer for the app, so every value `/observed` reports is read
/// off the production models — see `AppPairLinkHost.observed`.
@MainActor final class PairLinkRun {
    let host: AppPairLinkHost

    init(receiveRoot: URL) throws {
        host = try AppPairLinkHost(options: .init(
            baseURL: Config.origin, receiveRoot: receiveRoot,
            defaultsSuite: "com.relayium.acceptance.\(Config.runTag)"))
        host.logEvent = { log($0) }
    }

    /// `create` mints a real code on the local server; `join` takes one the
    /// launcher read off the other endpoint.
    func start(action: String, code: String) {
        host.start()
        Task { @MainActor in
            switch action {
            case "create":
                let bearer = ProcessInfo.processInfo
                    .environment["RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN"] ?? ""
                guard !bearer.isEmpty else {
                    return state.failed("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN is required to mint a code")
                }
                state.set(phase: "minting")
                guard let minted = await host.createCode(token: bearer) else {
                    return state.failed("mint did not produce a code: \(host.fileModel.state)")
                }
                state.set("code", minted)
                state.set(phase: "watching")
            case "join":
                guard isCompletePairingCode(code) else {
                    return state.failed("not a pairing code: \(code)")
                }
                state.set("code", code)
                host.joinCode(code)
                state.set(phase: "watching")
            default:
                state.failed("--- unknown action \(action); expected create or join")
            }
        }
    }

    func teardown() { host.teardown() }
}

// MARK: - Device Inbox, between two macOS processes

/// The receiving Mac: resident, unattended, writing into the run's own folder.
///
/// It reports what is ON DISK rather than what it recorded, which is the
/// difference between proving a delivery landed and proving a receiver kept a
/// tidy list about one that did not.
@MainActor final class InboxReceiverRun {
    let host: AppInboxReceiverHost

    init(receiveRoot: URL) throws {
        let bearer = ProcessInfo.processInfo
            .environment["RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN"] ?? ""
        guard !bearer.isEmpty else {
            fail("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN is required for inbox-receiver")
        }
        host = try AppInboxReceiverHost(
            origin: Config.origin, bearer: bearer, receiveRoot: receiveRoot,
            journalRoot: receiveRoot.deletingLastPathComponent()
                .appendingPathComponent("inbox-journal-\(Config.runTag)", isDirectory: true))
    }

    func start() {
        Task { @MainActor in
            state.set(phase: "adopting")
            if let problem = await host.start() {
                return state.failed(problem)
            }
            state.set(phase: "receiving")
        }
    }

    /// The live view: what this Mac has actually written so far, and the runtime
    /// state it would render. Polled by the launcher, which decides for itself
    /// when enough has arrived — this role has no terminal `done` of its own,
    /// because a resident receiver never finishes.
    func observed() -> [String: Any] {
        let receipts = host.receipts()
        return [
            "state": String(describing: host.state),
            "signedIn": host.isSignedIn,
            "folderChosen": host.folderIsUsable,
            "policy": String(describing: host.policy),
            "settingsError": host.settingsError as Any,
            "files": receipts.map {
                ["name": $0.name, "path": $0.path as Any,
                 "size": $0.size, "sha256": $0.sha256]
            },
        ]
    }

    func teardown() { host.teardown() }
}

/// The sending Mac: the same `InboxSendModel` the macOS surface drives.
@MainActor final class InboxSenderRun {
    let host: AppInboxSenderHost
    private let targetName: String

    init(stagingRoot: URL, targetName: String) throws {
        let bearer = ProcessInfo.processInfo
            .environment["RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN"] ?? ""
        guard !bearer.isEmpty else {
            fail("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN is required for inbox-sender")
        }
        self.targetName = targetName
        host = try AppInboxSenderHost(origin: Config.origin, bearer: bearer,
                                      stagingRoot: stagingRoot)
    }

    func start() {
        Task { @MainActor in
            state.set(phase: "reading-devices")
            await host.start()
            // The target has to APPEAR: the receiver enrols asynchronously, and
            // a device that has not published a key yet is correctly reported as
            // unable to receive rather than offered.
            let listed = Date().addingTimeInterval(120)
            while Date() < listed {
                if host.selectTarget(named: targetName) { break }
                if case .unavailable(let failure) = host.directory {
                    return state.failed("the device list could not be read: \(failure)")
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                host.refreshTargets()
            }
            guard host.selectTarget(named: targetName) else {
                return state.failed(
                    "\(targetName) never became a sendable target; offered: "
                    + host.targetNames.joined(separator: ", "))
            }
            state.set("target", targetName)
            state.set(phase: "sending")
            do {
                try host.send(batch: Config.batch)
            } catch {
                return state.failed("could not stage the batch: \(error)")
            }
            let deadline = Date().addingTimeInterval(180)
            while Date() < deadline {
                if host.isSaved {
                    // What a SENDER can state is what it handed over. The
                    // receiver's own receipts are read off its disk.
                    state.finish(receipts: Config.sentReceipts)
                    return
                }
                if let failure = host.terminalFailure {
                    return state.failed("device delivery failed: \(failure)")
                }
                if let refusal = host.refusal {
                    return state.failed("device delivery refused: \(refusal)")
                }
                state.set("activity", String(describing: host.activity ?? .staged))
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            state.failed("timed out waiting for the other device to save the delivery")
        }
    }

    func teardown() { host.teardown() }
}

// MARK: - Device Inbox, a BIDIRECTIONAL endpoint

/// The extra batches a bidirectional endpoint sends, beside the shared
/// `AcceptanceBatch` every run already compares byte for byte.
///
/// **Distinct names AND distinct bytes**, from the shared fixture and from each
/// other, for exactly the reason `AcceptanceBatch` gives for its own per-file
/// seeds: a direction — or a delivery that lost a race — carrying its
/// neighbour's bytes under its own name still produces the right count, the
/// right names and the right sizes, and only a digest can see it. Reusing
/// `AcceptanceBatch.make` under another tag would have given distinct names and
/// IDENTICAL bytes, which is the half that cannot fail.
///
/// The generator is eight lines rather than a call into the shared fixture
/// because `AcceptanceBatch.deterministicBytes` is internal to `RelayiumPeerKit`
/// and this executable is a different module. It is fixture arithmetic, not
/// product logic: nothing below is a rule the app also implements.
enum EndpointBatch {

    /// `primary` is the shared mixed batch — a loose file, a two-level folder,
    /// a zero-byte leaf in the MIDDLE of the stream and one file larger than a
    /// single frame — so the forward direction keeps exactly the byte-integrity
    /// property this suite has always asserted.
    static func make(label: String, runTag: String) -> [(meta: FileMeta, bytes: [UInt8])] {
        switch label {
        case "reverse":
            let tree = "reply-\(runTag)"
            return [
                entry(name: "reply-\(runTag).txt", path: nil, seed: 101, size: 61),
                // Nested, so path fidelity is proven in BOTH directions rather
                // than only the one the suite happened to start with.
                entry(name: "nested.bin", path: "\(tree)/inner/nested.bin", seed: 102, size: 8_192),
            ]
        case "competing":
            return [entry(name: "competing-\(runTag).bin", path: nil, seed: 103, size: 1_024)]
        default:
            return AcceptanceBatch.make(runTag: runTag)
        }
    }

    private static func entry(name: String, path: String?, seed: UInt64, size: Int)
        -> (meta: FileMeta, bytes: [UInt8]) {
        let bytes = deterministicBytes(seed: seed, count: size)
        return (FileMeta(name: name, size: bytes.count, path: path), bytes)
    }

    /// A fixed 64-bit LCG, seeded well clear of `AcceptanceBatch`'s 1…5.
    /// Reproducible, so a failing run can be re-derived from its tag and its
    /// digests re-checked by hand, and non-repeating, so no two files and no two
    /// offsets inside one file carry the same bytes.
    private static func deterministicBytes(seed: UInt64, count: Int) -> [UInt8] {
        var state = seed &* 0x9E37_79B9_7F4A_7C15 &+ 0x1234_5678_9ABC_DEF
        var out = [UInt8]()
        out.reserveCapacity(count)
        for _ in 0..<count {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            out.append(UInt8(truncatingIfNeeded: state >> 33))
        }
        return out
    }

    static func receipts(for batch: [(meta: FileMeta, bytes: [UInt8])]) -> [FileReceipt] {
        batch.map { FileReceipt.forSource($0.meta, bytes: $0.bytes) }
    }
}

/// **One macOS Device Inbox endpoint: the app's receiving half and its sending
/// half, in one process, over one DURABLE state root.**
///
/// ## Why this role exists beside `inbox-sender` and `inbox-receiver`
///
/// Those two prove a delivery. They cannot prove a CONVERSATION: each owns one
/// half of the feature, neither holds a conversation index, and the send half
/// there is not wired to the receive half at all — so nothing in this suite
/// could observe a sent row, a local deletion, or a history that survives a
/// restart. 1.2.11 makes each conversation one bidirectional, erasable surface,
/// and the only honest evidence for that is two processes that are each a whole
/// endpoint.
///
/// ## What is production here, and what is substituted
///
/// The controller, the engine factory, the journal, the message stores, the
/// conversation index, the send model, the uploader, the sender client and the
/// session are the shipped ones, assembled from the same `AppEnvironment`
/// factories `RelayiumApp` calls — including **the three seams that join the
/// two halves**, installed here with the same shapes and the same weak capture
/// the scene uses. Nothing below re-implements a rule the product owns: every
/// assertion this role can support is read off a published model or off bytes
/// this process wrote to disk.
///
/// Substituted, and only for what a headless process cannot have:
///
///  * the folder bookmark store and the device key store are the in-memory ones
///    — the shipped pair are a `UserDefaults` bookmark and a keychain item in an
///    access group this unsigned binary has no entitlement for, which
///    `AppInboxHosts` already records failing closed before a byte moved. The
///    consequence is stated rather than hidden: **a restart re-grants the folder
///    and re-enrols with a fresh device key.** The row id is unchanged (it
///    belongs to the credential), and every durable thing a no-resurrection
///    claim rests on — the conversation index, both message stores, the journals
///    and the received files — is on disk under `--state-root` and is reopened
///    from exactly the same paths.
///  * the account arrives as a bearer the launcher minted rather than through a
///    sign-in form, exactly as the other inbox roles take it.
///
/// ## `presentingText: true`, and why this build may claim it
///
/// `InboxProtocol.announcedCapabilities(presentingText:)` documents the token as
/// a claim about a SURFACE — that this receiver presents a text delivery AS
/// text — and warns that a build rendering nothing must not make it. This one
/// does render it: `/observed` reads every body back through
/// `InboxController.message(for:)` and `sentMessage(for:)`, the production
/// accessors, and reports the text. That read-back IS the surface, and the
/// acceptance assertion "the receiver holds this exact text" is what consumes
/// it. Announcing the base set instead would have made every text send in this
/// run refuse with `textUnsupported` before anything left either Mac.
@MainActor final class InboxEndpointRun {
    private let controller: InboxController
    private let deliveries: InboxSendModel
    private let session: AccountSession
    private let bridge: InboxSessionBridge
    private let bearer: String

    private let stateRoot: URL
    private let receiveRoot: URL
    private let accountsRoot: URL
    /// Where the files this endpoint SENDS are read from — outside the pending
    /// store's own root, because a user's chosen files are not in the app's
    /// staging area and a fixture that put them there would be staging from the
    /// one directory `PendingUploadStore` owns.
    private let sourceRoot: URL

    private var selfDeviceID = ""
    private var selfDeviceName = ""

    init(stateRoot: URL) throws {
        let bearer = ProcessInfo.processInfo
            .environment["RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN"] ?? ""
        guard !bearer.isEmpty else {
            fail("RELAYIUM_ACCEPTANCE_ACCOUNT_TOKEN is required for inbox-endpoint")
        }
        // Locals first, properties after: every directory below is derived from
        // the one root, and building them as plain values keeps the whole layout
        // readable in one place instead of spread across `self` assignments.
        let receive = stateRoot.appendingPathComponent("receive", isDirectory: true)
        let outgoing = stateRoot.appendingPathComponent("outgoing", isDirectory: true)
        let stagingRoot = stateRoot.appendingPathComponent("staging", isDirectory: true)
        let accounts = stateRoot.appendingPathComponent("store", isDirectory: true)
            .appendingPathComponent("accounts", isDirectory: true)
        for directory in [receive, outgoing, stagingRoot, accounts] {
            try FileManager.default.createDirectory(at: directory,
                                                    withIntermediateDirectories: true)
        }
        self.bearer = bearer
        self.stateRoot = stateRoot
        receiveRoot = receive
        sourceRoot = outgoing
        accountsRoot = accounts

        let origin = Config.origin
        // Account-scoped, and split into the same four directories
        // `AppEnvironment` splits its own into — journals, `messages`,
        // `sent-messages`, `conversations`. The split is not cosmetic: received
        // records are named by CENTRAL's task id and sent ones by this Mac's job
        // id, and nothing makes those namespaces disjoint, so one directory
        // would let a replayed receive overwrite a message the user sent.
        let accountDirectory: @Sendable (InboxAccountID) -> URL = { account in
            accounts.appendingPathComponent(account.value, isDirectory: true)
        }
        let journalStore: @Sendable (InboxAccountID) -> InboxJournalStore? = { account in
            InboxJournalStore(directory: accountDirectory(account))
        }
        let messageStore: @Sendable (InboxAccountID) -> InboxMessageStore? = { account in
            InboxMessageStore(directory: accountDirectory(account)
                .appendingPathComponent("messages", isDirectory: true))
        }
        let sentMessageStore: @Sendable (InboxAccountID) -> InboxMessageStore? = { account in
            InboxMessageStore(directory: accountDirectory(account)
                .appendingPathComponent("sent-messages", isDirectory: true))
        }
        let conversationStore: @Sendable (InboxAccountID) -> InboxConversationStore? = { account in
            InboxConversationStore(directory: accountDirectory(account)
                .appendingPathComponent("conversations", isDirectory: true))
        }

        let folderStore = InMemoryInboxFolderStore()
        let receiving = InboxController(runtime: InboxRuntime(
            folder: InboxReceiveFolder(store: folderStore),
            makeEngine: AppEnvironment.makeInboxEngineFactory(
                baseURL: origin, keys: InMemoryInboxDeviceKeyStore(),
                journalStore: journalStore, messageStore: messageStore,
                folderStore: folderStore),
            // No notifier and no reveal, for the reason `AppInboxReceiverHost`
            // records: a headless peer has no notification centre and must never
            // hand a received path to the Finder.
            messageStore: messageStore,
            sentMessageStore: sentMessageStore,
            conversationStore: conversationStore,
            legacyReceipts: { account in
                guard let journals = journalStore(account) else { return [] }
                return try journals.completedReceipts()
            },
            // Wired, and it has to be: without it the controller learns no
            // device NAMES, so `displayName(for:)` falls back to an id prefix
            // and `isRemoved` can never answer. It is the production call.
            deviceDirectory: { token in
                try await InboxSenderClient(baseURL: origin, token: token).devices()
            },
            platform: AppEnvironment.inboxPlatform,
            // See the type comment. This endpoint presents received text through
            // `/observed`, so the claim is one it keeps.
            capabilities: InboxProtocol.announcedCapabilities(presentingText: true),
            appVersion: "acceptance"))
        controller = receiving

        // `drafts: nil`, exactly as `RelayiumApp` and `AppInboxSenderHost` pass
        // it: a draft store is the authority to delete another process's only
        // copy of a file, and nothing here can have come from one. The
        // content-key store is in memory for the entitlement reason
        // `AppInboxHosts` records — which also means a delivery still in flight
        // does not survive this endpoint's restart, and the launcher restarts
        // only once everything it is asserting on has reached `saved`.
        let delivering = AppEnvironment.makeInboxSendModel(
            baseURL: origin,
            pending: PendingUploadSupport(store: PendingUploadStore(root: stagingRoot),
                                          keys: InMemoryStoredLinkKeyStore()))
        deliveries = delivering

        // The credential reaches the session the way the app's does — through a
        // token store `restore()` reads — so the account state this endpoint
        // adopts is produced by the shipped `AccountSession`, not written here.
        let tokens = InMemoryTokenStore()
        try tokens.save(bearer)
        session = AppEnvironment.makeSession(baseURL: origin, tokenStore: tokens)
        bridge = InboxSessionBridge(controller: receiving)

        bridge.observe(session.$state, bearer: { [session] in session.bearerToken })
        delivering.observe(session.$state)

        // **The three seams, copied in shape from `RelayiumApp` and nowhere
        // else.** They are what make a sent delivery appear in the same local
        // conversation as a received one, and they are the only reason this
        // process can state a sender-side `saved`. Getting them wrong would not
        // fail loudly — it would produce an endpoint whose conversations are
        // half a product — so they are written here exactly as the scene writes
        // them, weak capture included.
        delivering.onSentHistory = { [weak receiving] event, body in
            receiving?.recordSentHistory(event, messageBody: body)
        }
        // Separate from the above ON PURPOSE, as in the scene: a state change
        // may never CREATE a row, or an update landing after a deletion would
        // write the entry back — which is the resurrection this run asserts
        // against, reintroduced one layer above the tombstones.
        delivering.onSentStateChanged = { [weak receiving] accountId, job, state, task in
            receiving?.updateSentHistory(accountID: accountId, jobID: job,
                                         state: state, taskID: task)
        }
        delivering.isSentHistoryDeleted = { [weak receiving] accountId, job in
            receiving?.isSentHistoryDeleted(accountID: accountId, jobID: job) ?? false
        }
    }

    /// Adopt the account, grant the folder, switch unattended receiving on, and
    /// learn which device row this credential authenticates as — in that order,
    /// each step WAITED FOR rather than assumed.
    ///
    /// The waiting is the correctness, for the reason `AppInboxReceiverHost`
    /// records: `chooseFolder` and `setPolicy` are account-scoped and silently
    /// discard a grant issued before the session has been adopted.
    func start() {
        Task { @MainActor in
            state.set(phase: "adopting")
            await session.restore()
            guard await waitFor({ [controller] in controller.isSignedIn }) else {
                return state.failed("the endpoint never adopted the account: \(session.state)")
            }
            controller.chooseFolder(receiveRoot)
            if let problem = controller.settingsError {
                return state.failed("the receive folder was refused: \(problem)")
            }
            guard await waitFor({ [controller] in controller.folder.isChosen }) else {
                return state.failed("the receive folder was not recorded")
            }
            controller.setPolicy(.auto)
            if let problem = controller.settingsError {
                return state.failed("unattended receiving was refused: \(problem)")
            }
            guard await waitFor({ [controller] in controller.policy == .auto }) else {
                return state.failed("unattended receiving was not recorded")
            }
            // **Asked, not assumed.** The row id is minted server-side when a
            // login is approved, so the only honest way to learn this
            // endpoint's own identity is to ask which row the credential
            // authenticates as. It is what lets the launcher assert that the
            // peer id the OTHER endpoint attributed a delivery to is this
            // endpoint's real row — authenticated attribution, checked across
            // two processes rather than within one.
            do {
                let rows = try await InboxSenderClient(baseURL: Config.origin,
                                                       token: bearer).devices()
                guard let mine = rows.first(where: { $0.isCurrent }) else {
                    return state.failed("central lists no current device for this credential")
                }
                selfDeviceID = mine.id
                selfDeviceName = mine.name
            } catch {
                return state.failed("the account's device list could not be read: \(error)")
            }
            state.set("deviceID", selfDeviceID)
            state.set("deviceName", selfDeviceName)
            deliveries.refreshTargets(token: session.bearerToken ?? "")
            state.set(phase: "ready")
        }
    }

    /// Poll a main-actor condition with a real ceiling, so a stuck step is a
    /// NAMED failure rather than a delivery the launcher later reports as never
    /// having arrived.
    private func waitFor(_ condition: @escaping () -> Bool,
                         seconds: TimeInterval = 30) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return condition()
    }

    func teardown() { controller.signedOut() }

    // MARK: - the live view

    /// Everything this endpoint can state, read off the production models and
    /// off its own disk. Nothing here is derived and nothing is remembered: a
    /// value that is not in a published model or in a file is not reported.
    ///
    /// Assembled key by key rather than as one literal: a single heterogeneous
    /// `[String: Any]` this wide, with four nested `map`s inside it, is the
    /// shape Swift's type checker gives up on, and the failure is a build error
    /// about the expression rather than about anything wrong with the facts.
    func observed() -> [String: Any] {
        var out: [String: Any] = [:]
        out["phase"] = state.phase
        out["signedIn"] = controller.isSignedIn
        out["folderChosen"] = controller.folder.isChosen
        out["policy"] = String(describing: controller.policy)
        out["runtimeState"] = String(describing: controller.state)
        out["storeIssue"] = controller.conversationStoreIssue
        out["selfDeviceID"] = selfDeviceID
        out["selfDeviceName"] = selfDeviceName
        out["accountID"] = controller.activeAccountID ?? ""
        // The launcher walks these itself, so "the body is gone" is an
        // observation about bytes on disk rather than a model reporting its own
        // success.
        out["stateRoot"] = stateRoot.path
        out["receiveRoot"] = receiveRoot.path
        out["accountsRoot"] = accountsRoot.path
        out["directory"] = String(describing: deliveries.directory)
        out["deletedTimelineIDs"] = controller.deletedTimelineIDs.sorted()
        out["candidates"] = candidateFacts()
        out["sends"] = sendFacts()
        out["conversations"] = conversationFacts()
        out["files"] = receipts().map(Self.encode(receipt:))
        if let problem = controller.settingsError {
            out["settingsError"] = String(describing: problem)
        }
        if let refusal = deliveries.refusal { out["refusal"] = String(describing: refusal) }
        return out
    }

    /// The account's devices as the composer would offer them — blocked rows
    /// INCLUDED, which is the product's own "truthful target list" rule and the
    /// only way a launcher can assert that a device which never enrolled is
    /// listed and not sendable rather than quietly missing.
    private func candidateFacts() -> [[String: Any]] {
        deliveries.candidates.map { candidate -> [String: Any] in
            var row: [String: Any] = [:]
            row["id"] = candidate.id
            row["name"] = candidate.name
            row["kind"] = candidate.kind
            row["sendable"] = candidate.isSendable
            row["canReceiveText"] = candidate.canReceiveText
            row["availability"] = String(describing: candidate.availability)
            return row
        }
    }

    private func sendFacts() -> [[String: Any]] {
        deliveries.items.map { item -> [String: Any] in
            var row: [String: Any] = [:]
            row["id"] = item.id
            row["activity"] = String(describing: item.activity)
            // The ONE predicate allowed to answer "has it arrived".
            row["isSavedOnTarget"] = item.activity.isSavedOnTarget
            row["targetDeviceID"] = item.targetDeviceID
            row["fileCount"] = item.fileCount
            row["byteCount"] = item.byteCount
            if let name = item.targetName { row["targetName"] = name }
            if let task = item.taskID { row["taskID"] = task }
            return row
        }
    }

    private static func encode(receipt: FileReceipt) -> [String: Any] {
        var entry: [String: Any] = [:]
        entry["name"] = receipt.name
        entry["size"] = receipt.size
        entry["sha256"] = receipt.sha256
        if let path = receipt.path { entry["path"] = path }
        return entry
    }

    /// The conversations exactly as the product projects them, in the store's
    /// own `(at desc, id desc)` order — reported rather than re-sorted, so the
    /// launcher's ordering assertion is about `InboxConversationStore` and not
    /// about this method.
    private func conversationFacts() -> [[String: Any]] {
        controller.conversations.map { conversation -> [String: Any] in
            var out: [String: Any] = [:]
            out["peerDeviceID"] = conversation.peerDeviceID
            out["peerName"] = controller.displayName(for: conversation)
            out["peerNameSnapshot"] = conversation.peerNameSnapshot
            out["unreadCount"] = conversation.unreadCount
            out["isRemoved"] = controller.isRemoved(conversation.peerDeviceID)
            out["entries"] = conversation.entries.map(entryFacts(_:))
            return out
        }
    }

    private func entryFacts(_ entry: InboxTimelineEntry) -> [String: Any] {
        var row: [String: Any] = [:]
        row["id"] = entry.id
        row["direction"] = entry.direction.rawValue
        row["kind"] = entry.kind.rawValue
        // Milliseconds, so the launcher can assert the timeline really is
        // non-increasing rather than taking the store's word for its own order.
        row["atMillis"] = Int64(entry.at.timeIntervalSince1970 * 1000)
        row["byteCount"] = entry.byteCount
        row["fileCount"] = entry.fileCount
        row["files"] = entry.files.map { reference -> [String: Any] in
            ["name": reference.displayName, "path": reference.urlPath]
        }
        row["sentFiles"] = entry.sentFiles.map { snapshot -> [String: Any] in
            ["name": snapshot.name, "size": snapshot.size]
        }
        if let sent = entry.sentState { row["sentState"] = sent.rawValue }
        if let id = entry.taskID { row["taskID"] = id }
        if let id = entry.jobID { row["jobID"] = id }
        if let id = entry.messageID { row["messageID"] = id }
        if let id = entry.sentMessageID { row["sentMessageID"] = id }
        // **The body, through the production accessors and no other door.**
        // `message(for:)` answers only for a received entry and
        // `sentMessage(for:)` only for a sent one, each reading its own
        // protected store — so a text reported here is a text the product itself
        // would render, and a deleted one reports nothing because its file is
        // gone.
        if let body = controller.message(for: entry) ?? controller.sentMessage(for: entry) {
            row["text"] = body.text
        }
        return row
    }

    /// Every file this endpoint has actually written, read back OFF DISK — not
    /// out of a receipt list, for the reason `AppInboxReceiverHost` states: a
    /// receiver that recorded a delivery it never committed would produce a
    /// perfect receipt list.
    private func receipts() -> [FileReceipt] {
        guard let files = FileManager.default.enumerator(
            at: receiveRoot, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        var out: [FileReceipt] = []
        for case let url as URL in files {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?
                .isRegularFile == true else { continue }
            guard let digest = sha256Hex(contentsOf: url),
                  let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
            else { continue }
            out.append(FileReceipt(name: url.lastPathComponent, path: relativePath(of: url),
                                   size: size, sha256: digest))
        }
        return out.sorted { $0.name < $1.name }
    }

    /// The path under the receive root, or nil for a file that landed loose. A
    /// receiver that flattened a tree would otherwise produce receipts a
    /// name-and-digest comparison accepts.
    private func relativePath(of url: URL) -> String? {
        let root = receiveRoot.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        guard path.hasPrefix(root + "/") else { return nil }
        let relative = String(path.dropFirst(root.count + 1))
        return relative.contains("/") ? relative : nil
    }

    // MARK: - the launcher's hand on the production paths

    /// Every command drives a shipped model and reports what that model said.
    ///
    /// **Nothing here decides an outcome.** A refusal is the one
    /// `InboxSendModel` published, a deletion's effect is read back out of
    /// `InboxController.deletedTimelineIDs`, and a target is aimed at by id
    /// without this fixture applying a sendability filter of its own — so a send
    /// to a device that cannot receive is refused by the product's own guards
    /// rather than declined here. There are two of those guards and the answer
    /// reports both: `selectTarget` refuses to bind a blocked row, and the send
    /// itself is issued regardless and refuses on its own terms.
    func drive(_ command: String, _ body: [String: Any]) -> [String: Any] {
        switch command {
        case "refresh-targets":
            deliveries.refreshTargets(token: session.bearerToken ?? "")
            return ["ok": true]

        case "refresh":
            controller.refreshConversations()
            return ["ok": true, "storeIssue": controller.conversationStoreIssue]

        case "mark-read":
            guard let peer = body["peer"] as? String, !peer.isEmpty else {
                return ["error": "mark-read needs peer"]
            }
            controller.markConversationRead(peer)
            return ["ok": true]

        case "send-text":
            guard let text = body["text"] as? String, !text.isEmpty else {
                return ["error": "send-text needs text"]
            }
            guard let aimed = aim(body) else {
                return ["error": "no candidate named \(body["name"] as? String ?? "-")",
                        "candidates": deliveries.candidates.map(\.name)]
            }
            // Issued even when the model REFUSED the aim. A send this fixture
            // declined would prove nothing about the product's guard, so the
            // model is asked and its own answer is reported.
            deliveries.sendText(text, token: session.bearerToken ?? "")
            var out = aimed.facts
            if let refusal = deliveries.refusal {
                out["refusal"] = String(describing: refusal)
                return out
            }
            out["ok"] = true
            return out

        case "send-files":
            guard let aimed = aim(body) else {
                return ["error": "no candidate named \(body["name"] as? String ?? "-")",
                        "candidates": deliveries.candidates.map(\.name)]
            }
            let label = (body["batch"] as? String) ?? "primary"
            let batch = EndpointBatch.make(label: label, runTag: Config.runTag)
            let selection: [SelectedFile]
            // Staged BEFORE the send and regardless of the aim, because
            // `send(files:)` refuses an empty selection before it ever reaches
            // its target guards — a refusal on an unstaged batch would be
            // `noSelection` and would say nothing about the device addressed.
            do { selection = try stage(batch, label: label) } catch {
                return ["error": "could not write the batch to send: \(error)"]
            }
            deliveries.send(files: selection, sourceDraftId: nil,
                            token: session.bearerToken ?? "")
            var out = aimed.facts
            if let refusal = deliveries.refusal {
                out["refusal"] = String(describing: refusal)
                return out
            }
            // The SENDER's own digests of the bytes it wrote, stated before the
            // far side has done anything, so the comparison at the end is
            // between two independent walks rather than one value copied twice.
            out["ok"] = true
            out["batch"] = label
            out["receipts"] = EndpointBatch.receipts(for: batch).map(Self.encode(receipt:))
            return out

        case "send-competing":
            return competing(body)

        case "delete-entry":
            guard let peer = body["peer"] as? String, !peer.isEmpty,
                  let id = body["id"] as? String, !id.isEmpty else {
                return ["error": "delete-entry needs peer and id"]
            }
            controller.deleteTimelineEntry(id, peerDeviceID: peer)
            return ["ok": true,
                    // Read back rather than assumed: the store REFUSES an id
                    // belonging to another peer, so a deletion that did not
                    // happen must not report that it did.
                    "tombstoned": controller.deletedTimelineIDs.contains(id),
                    "storeIssue": controller.conversationStoreIssue]

        case "delete-conversation":
            guard let peer = body["peer"] as? String, !peer.isEmpty else {
                return ["error": "delete-conversation needs peer"]
            }
            guard let conversation = controller.conversations
                .first(where: { $0.peerDeviceID == peer }) else {
                return ["error": "no conversation with \(peer)"]
            }
            // **The ids the surface OBSERVED**, which is the product's own
            // contract: a delivery committed between the screen being drawn and
            // the user confirming has no tombstone and lands as a new unread
            // item, rather than disappearing into a permanent peer-wide ban.
            let observed = conversation.entryIDs
            controller.deleteConversation(peerDeviceID: peer, observedEntryIDs: observed)
            return ["ok": true, "observed": observed.sorted(),
                    "tombstoned": controller.deletedTimelineIDs.sorted(),
                    "storeIssue": controller.conversationStoreIssue]

        default:
            return ["error": "unknown command \(command)"]
        }
    }

    /// **A genuine competing send, refused by the product's own guard.**
    ///
    /// Two sends are issued in ONE main-actor turn: `InboxSendModel` takes its
    /// staging slot synchronously before the first call returns, so the second
    /// call meets a staging task that is genuinely in flight. Nothing here
    /// simulates contention, sets a flag, or reaches past a guard — the first
    /// delivery goes on to complete, which is the half a broken guard would also
    /// destroy, and the launcher asserts both halves.
    private func competing(_ body: [String: Any]) -> [String: Any] {
        guard let text = body["text"] as? String, !text.isEmpty else {
            return ["error": "send-competing needs text"]
        }
        guard let aimed = aim(body) else {
            return ["error": "no candidate named \(body["name"] as? String ?? "-")"]
        }
        let batch = EndpointBatch.make(label: "competing", runTag: Config.runTag)
        let selection: [SelectedFile]
        do { selection = try stage(batch, label: "competing") } catch {
            return ["error": "could not write the competing batch: \(error)"]
        }
        deliveries.send(files: selection, sourceDraftId: nil, token: session.bearerToken ?? "")
        // Captured BEFORE the second call, which clears `refusal` on entry.
        let first = deliveries.refusal.map { String(describing: $0) }
        deliveries.sendText(text, token: session.bearerToken ?? "")
        let second = deliveries.refusal.map { String(describing: $0) }
        var out = aimed.facts
        out["ok"] = true
        out["receipts"] = EndpointBatch.receipts(for: batch).map(Self.encode(receipt:))
        if let first { out["first"] = first }
        if let second { out["second"] = second }
        return out
    }

    /// What asking `InboxSendModel` to aim at one named device produced.
    ///
    /// **The distinction the first version of this fixture lost.** "This account
    /// has no device by that name" is the launcher's own mistake; "the model
    /// REFUSED to aim at that device" is the product answering. Collapsing both
    /// into `nil` made the fixture decline the send itself, so `InboxSendModel`
    /// was never asked and the run asserted on a fixture error rather than on a
    /// product guard.
    private struct Aim {
        /// The id the launcher asked for, always.
        let requestedID: String
        /// What `InboxSendModel.selectTarget` left in `selectedTargetID` — nil
        /// when the model refused to hold this row.
        let selectedID: String?
        /// The block the MODEL publishes for that row, nil for a sendable one.
        let block: String?

        var isBound: Bool { selectedID != nil && selectedID == requestedID }

        /// The facts every send answer carries, so a refusal can be read back to
        /// the guard that produced it rather than guessed at from its name.
        var facts: [String: Any] {
            var out: [String: Any] = ["requestedTarget": requestedID,
                                      "selectionRefused": !isBound]
            if let selectedID { out["target"] = selectedID }
            if let block { out["targetBlock"] = block }
            return out
        }
    }

    /// Aim at a target by NAME through the model's own door, and report what the
    /// model did with the request.
    ///
    /// **No sendability filter, and no aim of the fixture's own.**
    /// `AppInboxSenderHost.selectTarget(named:)` has a filter, which is right for
    /// a role whose whole job is to wait for a target to become sendable — but it
    /// would mean an adversarial send never reached `InboxSendModel`, and the
    /// refusal a run asserts on would be this fixture's rather than the product's.
    ///
    /// The previous selection is cleared FIRST, and that is the correctness here:
    /// `InboxSendModel.selectTarget` returns without touching `selectedTargetID`
    /// when it refuses a blocked row, so reading the selection back afterwards
    /// would report the PREVIOUS device and the send below would go to a machine
    /// nobody addressed. Cleared first, a refused aim leaves the model holding
    /// nothing and its own send guard answers.
    private func aim(_ body: [String: Any]) -> Aim? {
        guard let name = body["name"] as? String, !name.isEmpty,
              let candidate = deliveries.candidates.first(where: { $0.name == name })
        else { return nil }
        deliveries.selectTarget(nil)
        deliveries.selectTarget(candidate.id)
        return Aim(requestedID: candidate.id,
                   selectedID: deliveries.selectedTargetID,
                   block: candidate.availability.block?.rawValue)
    }

    /// Write one batch where a person's own files would be, and describe it the
    /// way the file picker would.
    ///
    /// Real files, because a device send reads real files: `PendingUploadStore
    /// .prepare` copies them into the app's staging root, and a fabricated
    /// in-memory selection would be a send this model has never been asked to
    /// perform.
    private func stage(_ batch: [(meta: FileMeta, bytes: [UInt8])],
                       label: String) throws -> [SelectedFile] {
        let source = sourceRoot.appendingPathComponent(label, isDirectory: true)
        var selected: [SelectedFile] = []
        for entry in batch {
            let relative = entry.meta.path ?? entry.meta.name
            let url = source.appendingPathComponent(relative)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try Data(entry.bytes).write(to: url)
            selected.append(SelectedFile(url: url, relativePath: relative,
                                         byteCount: Int64(entry.bytes.count)))
        }
        return selected
    }
}

// MARK: - assembly

/// **No default.** `AppEnvironment.defaultLinkReceiveDirectory()` is the user's
/// Downloads folder, and a receiving role that silently fell back to it would
/// write real files into a real person's folder — the one outcome the isolation
/// rules for this fixture name explicitly.
func requireReceiveRoot() -> URL {
    guard let root = Config.receiveRoot else {
        fail("--receive-root is required for \(role.rawValue)")
    }
    return root
}

/// **No default, for the same reason.** An endpoint with no state root would
/// have to invent one, and the two things that would be wrong with any invented
/// answer are the two this role exists to avoid: writing a person's real
/// Downloads folder, and losing the durable stores between the run that wrote
/// them and the restarted process that must find them unchanged.
func requireStateRoot() -> URL {
    guard let root = Config.stateRoot else {
        fail("--state-root is required for \(role.rawValue)")
    }
    return root
}

/// The assembled run, built on the main actor when `/start` arrives.
///
/// **Lazily, and that is a correctness requirement rather than a preference.**
/// Every receiving role is `@MainActor`, so assembling one means hopping to the
/// main actor — and on this executable the main actor IS the main thread, which
/// does not begin servicing work until `dispatchMain()` at the bottom of this
/// file. Assembling eagerly here and blocking on a semaphore until it finished
/// deadlocked on the first run: the main thread waited for a task that could
/// only run on the main thread.
@MainActor
final class RunBox {
    static let shared = RunBox()

    private var teardownRun: (() -> Void)?

    /// The live view `/observed` answers, installed by the roles that have one.
    ///
    /// A closure rather than a stored host, so a role with no link surface
    /// answers "no live view" instead of an empty one that reads like a link
    /// that produced nothing. Installed by the roles that serve a real `link/1`
    /// — `nearby-receiver` in the hub's room and `local-link-peer` on the link —
    /// plus `pair-link` and `inbox-endpoint`.
    private var observeRun: (() -> [String: Any])?

    /// The roles a launcher can also SEND through. Nil for every role that runs
    /// to a fixed script, which is all of them but `pair-link` and
    /// `inbox-endpoint`.
    private var driveRun: ((String, [String: Any]) -> [String: Any])?

    func observed() -> [String: Any]? { observeRun?() }

    func drive(_ command: String, _ body: [String: Any]) -> [String: Any]? {
        driveRun?(command, body)
    }

    /// Builds the role's run object and starts it. Any failure becomes a
    /// reported phase rather than an exit, so the launcher reads a `failed`
    /// status with a reason instead of losing the process.
    func start(body: Data) {
        do {
            switch Config.role {
            case .nearbyReceiver:
                let run = try NearbyReceiverRun(receiveRoot: requireReceiveRoot(),
                                                name: require("--name"))
                teardownRun = { run.teardown() }
                observeRun = { liveLinkFacts(host: run.host) }
                run.start()
            case .nearbySender:
                let run = NearbySenderRun(name: require("--name"),
                                          counterpart: require("--counterpart"))
                teardownRun = { run.teardown() }
                run.start()
            case .localLinkPeer:
                let run = try LocalLinkPeerRun(receiveRoot: requireReceiveRoot(),
                                               name: require("--name"))
                teardownRun = { run.teardown() }
                observeRun = { run.observed() }
                run.start()
            case .pairSender:
                let run = try PairSenderRun(receiveRoot: requireReceiveRoot())
                teardownRun = { run.teardown() }
                run.start()
            case .pairLink:
                let run = try PairLinkRun(receiveRoot: requireReceiveRoot())
                teardownRun = { run.teardown() }
                observeRun = { run.host.observed() }
                driveRun = { command, body in run.host.drive(command, body) }
                let parsed = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                run.start(action: (parsed?["action"] as? String) ?? "join",
                          code: (parsed?["code"] as? String) ?? "")
            case .inboxReceiver:
                let run = try InboxReceiverRun(receiveRoot: requireReceiveRoot())
                teardownRun = { run.teardown() }
                observeRun = { run.observed() }
                run.start()
            case .inboxSender:
                let run = try InboxSenderRun(stagingRoot: requireReceiveRoot(),
                                             targetName: require("--counterpart"))
                teardownRun = { run.teardown() }
                run.start()
            case .inboxEndpoint:
                let run = try InboxEndpointRun(stateRoot: requireStateRoot())
                teardownRun = { run.teardown() }
                observeRun = { run.observed() }
                driveRun = { command, body in run.drive(command, body) }
                run.start()
            case .pairReceiver:
                let run = try PairReceiverRun(receiveRoot: requireReceiveRoot())
                teardownRun = { run.teardown() }
                let parsed = (try? JSONSerialization.jsonObject(with: body))
                    as? [String: Any]
                run.start(code: (parsed?["code"] as? String) ?? "")
            }
        } catch {
            state.failed("could not assemble \(Config.role.rawValue): \(error)")
        }
    }

    func teardown() {
        teardownRun?()
        teardownRun = nil
        observeRun = nil
        driveRun = nil
    }
}

/// Read the live view from the control queue, without hanging on the main one.
///
/// Every model this reports is `@MainActor`, and the control API's handlers run
/// on the listener's own queue — so the hop is unavoidable. It is BOUNDED, and
/// that is the part worth stating: a main actor stuck inside a link is exactly
/// the situation a caller is polling to diagnose, and an unbounded
/// `DispatchQueue.main.sync` would answer that by hanging the one API that could
/// have reported it. A timeout instead surfaces as a 409 the caller can print.
///
/// Returns nil for "no live view" — either the role has none, or the main actor
/// did not answer in time; the route distinguishes neither because the caller's
/// next move is the same in both cases: poll again, then print and fail.
func mainActorObservation(timeout: TimeInterval = 5) -> [String: Any]? {
    let ready = DispatchSemaphore(value: 0)
    let box = ObservationBox()
    Task { @MainActor in
        box.value = RunBox.shared.observed()
        ready.signal()
    }
    guard ready.wait(timeout: .now() + timeout) == .success else { return nil }
    return box.value
}

/// The same bounded hop, for a command rather than a read. See
/// `mainActorObservation` for why it is bounded.
func mainActorDrive(_ command: String, _ body: [String: Any],
                    timeout: TimeInterval = 10) -> [String: Any]? {
    let ready = DispatchSemaphore(value: 0)
    let box = ObservationBox()
    let payload = SendableBox(body)
    Task { @MainActor in
        box.value = RunBox.shared.drive(command, payload.value)
        ready.signal()
    }
    guard ready.wait(timeout: .now() + timeout) == .success else { return nil }
    return box.value
}

/// Carries a decoded JSON body across the hop above. `[String: Any]` is not
/// `Sendable`, and it is genuinely immutable here — decoded once by the route
/// handler and read once on the main actor — so the box states that rather than
/// leaving the compiler to assume otherwise.
final class SendableBox: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}

/// A one-shot handoff across the queue boundary. Written on the main actor
/// before the semaphore is signalled and read only after that signal, so the
/// ordering the semaphore establishes is the whole synchronisation.
final class ObservationBox: @unchecked Sendable {
    var value: [String: Any]?
}

let control: LoopbackControlServer
do {
    control = try LoopbackControlServer(
        token: controlToken,
        routes: [
            .init(method: "POST", path: "/start") { body in
                guard state.phase == "idle" else {
                    return json(["error": "already started", "phase": state.phase], status: 409)
                }
                state.set(phase: "starting")
                Task { @MainActor in RunBox.shared.start(body: body) }
                return json(["ok": true])
            },
            .init(method: "GET", path: "/status") { _ in json(state.snapshot()) },
            // The live link view, for a caller that decides for itself when
            // enough has arrived. `/status` and `/result` are untouched: they
            // carry T2a's contract — a fixed batch and a terminal `done` — and a
            // UI acceptance run has neither.
            .init(method: "GET", path: "/observed") { _ in
                guard let facts = mainActorObservation() else {
                    return json(["error": "no live view for this role",
                                 "role": Config.role.rawValue], status: 409)
                }
                return json(facts)
            },
            // The launcher's own hand on the production send paths, for the
            // roles whose script the launcher owns rather than the peer:
            // `pair-link`, whose counterpart is a browser, and `inbox-endpoint`,
            // whose counterpart is a second Mac it also drives. Every other role
            // runs to a fixed script and says so rather than silently accepting
            // a command it ignores.
            .init(method: "POST", path: "/drive") { body in
                let parsed = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let command = (parsed?["command"] as? String) ?? ""
                guard let answer = mainActorDrive(command, parsed ?? [:]) else {
                    return json(["error": "this role cannot be driven",
                                 "role": Config.role.rawValue], status: 409)
                }
                return json(answer, status: answer["error"] == nil ? 200 : 400)
            },
            .init(method: "GET", path: "/result") { _ in json(state.result()) },
            .init(method: "POST", path: "/shutdown") { _ in
                Task { @MainActor in RunBox.shared.teardown() }
                // Answered before exiting, so the launcher sees a clean 200
                // rather than a connection reset it would have to treat as
                // indistinguishable from a crash.
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { exit(0) }
                return json(["ok": true])
            },
        ],
        log: { log($0) })
} catch {
    fail("could not open the control socket: \(error)")
}

do {
    let port = try control.start()
    // The ONE line the launcher parses. On stdout, alone, so the launcher never
    // has to scrape the log for it.
    print("RELAYIUM_PEER_READY {\"port\":\(port),\"role\":\"\(role.rawValue)\"}")
    fflush(stdout)
    log("control API on 127.0.0.1:\(port) for \(role.rawValue) at \(origin)")
} catch {
    fail("could not start the control API: \(error)")
}

dispatchMain()
