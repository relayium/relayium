import Foundation
import RelayiumAppKit
import RelayiumKit

/// **The app's own pairing-code `link/1` surface, assembled exactly as
/// `CrossNetworkConnectPane` assembles it.**
///
/// ## Why this host had to exist
///
/// `AppPairHost` next door drives `RealtimeSessionModel` — the LEGACY pairing
/// wire. Nothing in this repository could stand a real macOS `link/1` pairing
/// room up against a second endpoint, which is exactly the combination the
/// 1.2.5 cross-network regression lived in: `link/1` in a code room is dead on
/// LAN (`LINK_PAIRING_ROOM_SUPPORT` is never consulted there, relay-only ICE and
/// `RelayDeadline` are dead code) and unreachable from `AppPairHost`. Every
/// green suite was therefore green about a different path.
///
/// ## What is production here, and what is not
///
/// The models, the factory, the socket, the announcement, the router and the
/// legacy fallback are all `AppEnvironment`'s — the same call `RelayiumApp`
/// makes, with the same arguments in the same order:
///
///  * `createCode` mints through `RealtimeSessionModel.mintCode` and then
///    watches the room with `legacyRole: .initiator`, because the creator offers
///    on the legacy wire;
///  * `joinCode` watches with `.responder` and starts the legacy join behind it.
///
/// Both are `CrossNetworkConnectPane.mintAndWatch` / `join` with the SwiftUI
/// removed and nothing else changed. What is a policy rather than production is
/// the same short list `LinkCounterpart` records — admitting an unsolicited
/// link, confirming a pending SAS, accepting an offered batch, dismissing a
/// finished link — each of which is on the RECEIVING side of a decision the
/// other endpoint is making.
///
/// Isolation is a constructor argument for the reasons `AppReceiverHost` states:
/// the receive root, the defaults domain and the origin are all handed in,
/// because each is a thing that has already produced a wrong acceptance result
/// in this workspace when it was inherited from the machine.
@MainActor
public final class AppPairLinkHost {

    public struct Options {
        public var baseURL: URL
        /// Where a received batch lands. Never Downloads — see
        /// `AppReceiverHost.Options.receiveRoot`.
        public var receiveRoot: URL
        public var defaultsSuite: String

        public init(baseURL: URL, receiveRoot: URL, defaultsSuite: String) {
            self.baseURL = baseURL
            self.receiveRoot = receiveRoot
            self.defaultsSuite = defaultsSuite
        }
    }

    public let options: Options
    /// The legacy file model. It is not decoration: it mints the code, holds it
    /// and its expiry, and is what the legacy fallback adopts if the peer turns
    /// out not to speak `link/1` — the same division of labour the pane has.
    public let fileModel: RealtimeSessionModel
    public let textModel: RealtimeTextSessionModel
    public let link: LinkWorkspaceModel
    public let counterpart: LinkCounterpart

    private let pairingRoom = LinkRoomHandle()
    private let defaults: UserDefaults
    /// Which lane a legacy fallback landed on, if one did. Reported rather than
    /// inferred, so a run that expected a link and got the older wire says which
    /// wire it got instead of timing out on a message that was never coming.
    public private(set) var legacyFallback: (peerId: String, role: Role, mode: TransferMode)?

    public init(options: Options) throws {
        self.options = options
        try FileManager.default.createDirectory(at: options.receiveRoot,
                                                withIntermediateDirectories: true)
        guard let defaults = UserDefaults(suiteName: options.defaultsSuite) else {
            throw AppReceiverHost.HostError.unusableDefaultsSuite(options.defaultsSuite)
        }
        self.defaults = defaults
        let verification = VerificationPreference(defaults: defaults)
        let baseURL = options.baseURL
        let receiveRoot = options.receiveRoot

        // A code room has no same-network half, so the discovery model exists
        // only to own the announcement registry the workspace reads. It is never
        // started, which is what keeps this process out of any LAN room.
        let discovery = LanDiscoveryModel(connect: {
            SignalingClient.connect(
                wsBase: RealtimeConnectionFactory.signalingBase(baseURL),
                code: "", name: "acceptance")
        })
        let inboundRoom = InboundRoom()
        fileModel = AppEnvironment.makeRealtimeModel(
            baseURL: baseURL, verification: verification,
            nearby: discovery, inboundRoom: inboundRoom, pairingRoom: pairingRoom)
        fileModel.saveDirectory = receiveRoot
        textModel = AppEnvironment.makeRealtimeTextModel(
            baseURL: baseURL, verification: verification,
            nearby: discovery, inboundRoom: inboundRoom, pairingRoom: pairingRoom)
        link = AppEnvironment.makeLinkWorkspaceModel(
            baseURL: baseURL, verification: verification, nearby: discovery,
            // The SAME handle the two legacy models read their fallback socket
            // from. Two would be two rooms, and the fallback would build on the
            // one nobody joined.
            pairingRoom: pairingRoom,
            receiveDirectory: { receiveRoot })
        counterpart = LinkCounterpart(link: link)
    }

    public var logEvent: ((String) -> Void)? {
        get { counterpart.logEvent }
        set { counterpart.logEvent = newValue }
    }

    /// Attach the headless answers. Once, before any room is joined — a peer can
    /// be dialling the instant the socket opens.
    public func start() {
        counterpart.start()
        link.adoptLegacyRoom = { [weak self] peerId, role, config, mode in
            guard let self else { return }
            self.legacyFallback = (peerId, role, mode)
            self.logEvent?("legacy fallback: peer=\(peerId) role=\(role) lane=\(mode)")
            Task { @MainActor in
                switch mode {
                case .files: await self.fileModel.adoptRoom(peerId: peerId, role: role, config: config)
                case .text: await self.textModel.adoptRoom(peerId: peerId, role: role, config: config)
                }
            }
        }
    }

    /// `CrossNetworkConnectPane.createCode` → `mintAndWatch`, verbatim minus the
    /// account gate the launcher has already satisfied.
    public func createCode(token: String) async -> String? {
        await fileModel.mintCode(token: token)
        guard case let .showingCode(code, _) = fileModel.state else { return nil }
        watch(code: code, legacyRole: .initiator) { [weak self] in
            await self?.fileModel.join(code: code, role: .initiator)
        }
        return code
    }

    /// `CrossNetworkConnectPane.join`. A joiner ANSWERS on the legacy wire.
    public func joinCode(_ code: String) {
        watch(code: code, legacyRole: .responder) { [weak self] in
            await self?.fileModel.join(code: code)
        }
    }

    private func watch(code: String, legacyRole: Role,
                       legacyStart: @escaping () async -> Void) {
        let watched = link.watchPairingCode(code, legacyRole: legacyRole, files: [], sources: [])
        guard !watched else { return }
        Task { await legacyStart() }
    }

    // MARK: - what the launcher drives and reads

    /// One command from the launcher, dispatched to the production entry point
    /// the person on screen would have reached.
    ///
    /// A single seam rather than a route per verb, so the control server's
    /// surface does not grow with every acceptance step — and so a command this
    /// build does not implement answers with its own name instead of a 404 the
    /// caller has to guess the meaning of.
    public func drive(_ command: String, _ body: [String: Any]) -> [String: Any] {
        switch command {
        case "message":
            guard let text = body["body"] as? String, !text.isEmpty else {
                return ["error": "message needs a non-empty body"]
            }
            link.send(message: text)
            return ["ok": true]
        case "files":
            guard let name = body["name"] as? String,
                  let contents = body["contents"] as? String else {
                return ["error": "files needs name and contents"]
            }
            let bytes = [UInt8](Data(contents.utf8))
            let meta = FileMeta(name: name, size: bytes.count, path: nil)
            link.send(files: [meta], sources: [DataSource(name: name, bytes: bytes)])
            return ["ok": true, "size": bytes.count]
        default:
            return ["error": "unknown command", "command": command]
        }
    }

    public func send(message body: String) { link.send(message: body) }

    public func send(files: [FileMeta], sources: [PlaintextSource]) {
        link.send(files: files, sources: sources)
    }

    /// Everything about this link that can move, read off the models the
    /// production writers filled in. Nothing here is derived or remembered.
    public func observed() -> [String: Any] {
        func entries(_ receipts: [FileReceipt]) -> [[String: Any]] {
            receipts.map { receipt in
                var entry: [String: Any] = ["name": receipt.name, "size": receipt.size,
                                            "sha256": receipt.sha256]
                if let path = receipt.path { entry["path"] = path }
                return entry
            }
        }
        var out: [String: Any] = [
            "linkPhase": String(describing: link.connection),
            "hasSession": link.hasSession,
            "epoch": counterpart.current.epoch,
            "messages": counterpart.current.messages,
            "allMessages": counterpart.allMessages(),
            "files": entries(counterpart.receipts()),
            "allFiles": entries(counterpart.allReceipts()),
        ]
        if let sas = counterpart.current.sas { out["sas"] = sas }
        if case let .showingCode(code, _) = fileModel.state { out["code"] = code }
        if let batches = link.fileModel?.batches {
            out["batchStates"] = batches.map { "\($0.direction):\($0.state)" }
            out["outboundStates"] = batches.filter { $0.direction == .outbound }
                .map { "\($0.state)" }
        }
        if let fallback = legacyFallback {
            out["legacyFallback"] = ["peerId": fallback.peerId,
                                     "role": String(describing: fallback.role),
                                     "lane": String(describing: fallback.mode)]
        }
        return out
    }

    public func teardown() {
        link.leave()
        fileModel.cancel()
        textModel.reset()
        pairingRoom.release()
        defaults.removePersistentDomain(forName: options.defaultsSuite)
        try? FileManager.default.removeItem(at: options.receiveRoot)
    }
}
