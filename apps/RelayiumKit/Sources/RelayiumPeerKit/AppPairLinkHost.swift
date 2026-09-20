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
        case "stagedFile":
            // One file the HARNESS staged on disk, sent through the production
            // entry point. It exists because a renewal has to be proven inside
            // ONE long transfer, and `files` carries its bytes in the JSON body,
            // which the control server caps. A path is a few bytes, so that cap
            // — and the control server's authentication — are left exactly as
            // they are. What this must never become is "read any file the
            // process can": see `AppPairLinkStagedFile.admit`.
            guard let name = body["name"] as? String, !name.isEmpty,
                  let path = body["path"] as? String else {
                return ["error": "stagedFile needs name and path"]
            }
            let root = AppPairLinkStagedFile.stagingRoot(besideReceiveRoot: options.receiveRoot)
            let admitted: URL
            switch AppPairLinkStagedFile.admit(path: path, stagingRoot: root) {
            case let .success(url): admitted = url
            case let .failure(refusal):
                return ["error": "stagedFile refused", "reason": refusal.rawValue]
            }
            // The descriptor is the authority from here. `FileURLSource` opens
            // with `O_NOFOLLOW | O_NONBLOCK`, checks `S_IFREG` with `fstat` on
            // what it actually opened, and pins that descriptor for the whole
            // transfer — so a leaf swapped for a symlink, a FIFO or a directory
            // after `admit` looked is still refused, and the size below is the
            // opened file's, never a number the caller supplied.
            let source: FileURLSource
            do { source = try FileURLSource(url: admitted, name: name) } catch {
                return ["error": "stagedFile refused", "reason": "unreadable"]
            }
            let meta = FileMeta(name: name, size: source.size, path: nil)
            link.send(files: [meta], sources: [source])
            return ["ok": true, "size": source.size]
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
        // The relayed link's bound, read straight off the model and nothing
        // else. An acceptance run has to SEE the initial boundary and see it
        // advance — a link that merely survived proves nothing about renewal,
        // because an existing TURN allocation can outlive its REST credential.
        // Absent, not zero, when the link has no relayed bound at all.
        if let deadline = link.relayDeadline {
            out["relayExpiresAtMs"] = Int64(deadline.expiresAt.timeIntervalSince1970 * 1000)
            out["relayDeadlineAtMs"] = Int64(deadline.deadlineAt.timeIntervalSince1970 * 1000)
        }
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

// staged-file gate: BEGIN — Foundation only, compiled and driven on its own by
// `AppPairLinkStagedFileTests`. Nothing between the markers may name a product
// type, or that test stops being able to execute this exact source.

/// Why a staged path was refused. The raw value is what the launcher sees.
public enum AppPairLinkStagedFileRefusal: String, Error {
    /// Not an absolute path. A relative one would be resolved against a working
    /// directory the launcher does not control.
    case notAbsolute
    /// The staging directory is missing, is not a directory, or is ITSELF a
    /// symbolic link — which could point anywhere.
    case stagingRootUnusable
    /// Not a strict child of the staging directory: outside it, the directory
    /// itself, or spelled with `.`/`..`/empty components.
    case outsideStaging
    /// A component INSIDE the staging directory — the leaf or any parent — is a
    /// symbolic link.
    case symlink
    case missing
    /// A directory, FIFO, socket or device where a regular file was required.
    case notRegularFile
}

/// The one question `stagedFile` asks before it opens anything: is this path a
/// regular file strictly inside the harness-owned staging directory, reached
/// without following a single symbolic link inside that directory?
public enum AppPairLinkStagedFile {
    /// Beside `native-received`, so one run directory holds both and the
    /// launcher can stage `run/native-staged/<file>` without being told a path.
    public static let directoryName = "native-staged"

    public static func stagingRoot(besideReceiveRoot receiveRoot: URL) -> URL {
        receiveRoot.deletingLastPathComponent()
            .appendingPathComponent(directoryName, isDirectory: true)
    }

    /// - Returns: the canonical URL to open, or why not.
    ///
    /// ## Symbolic links, and the one place they are allowed
    ///
    /// An ANCESTOR of the staging directory may be a link — the artifact root
    /// this runs under routinely is — so both the staging directory and the
    /// candidate are compared by their RESOLVED ancestry, consistently, rather
    /// than by how either happened to be spelled. Everything from the staging
    /// directory's own name downwards is examined with `lstat` and refused if
    /// it is a link: that is the part a staged tree controls, and a link there
    /// is how a staged name would reach a file outside it.
    public static func admit(path: String,
                             stagingRoot: URL) -> Result<URL, AppPairLinkStagedFileRefusal> {
        guard path.hasPrefix("/") else { return .failure(.notAbsolute) }

        // The staging directory: ancestors resolved, its own name NOT followed.
        guard let parent = canonical(stagingRoot.deletingLastPathComponent().path) else {
            return .failure(.stagingRootUnusable)
        }
        let root = parent == "/" ? "/" + stagingRoot.lastPathComponent
                                 : parent + "/" + stagingRoot.lastPathComponent
        guard kind(of: root) == .directory else { return .failure(.stagingRootUnusable) }

        // No lexical games: a component that is empty, `.` or `..` is refused
        // outright rather than normalised, so what is walked below is exactly
        // what was asked for.
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
            .dropFirst().map(String.init)
        guard !components.isEmpty,
              !components.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
            return .failure(.outsideStaging)
        }

        // Find where the candidate enters the staging directory, by resolved
        // ancestry. Shortest prefix first, so a link INSIDE staging that points
        // back at it cannot be mistaken for the way in.
        var inside: [String]?
        for end in 1..<components.count {
            let prefix = "/" + components[0..<end].joined(separator: "/")
            guard components[end - 1] == stagingRoot.lastPathComponent,
                  let resolvedParent = canonical((prefix as NSString).deletingLastPathComponent),
                  (resolvedParent == "/" ? "/" : resolvedParent + "/")
                      + components[end - 1] == root else { continue }
            inside = Array(components[end...])
            break
        }
        guard let inside, !inside.isEmpty else { return .failure(.outsideStaging) }

        // Walk it. Every parent a real directory, the leaf a real regular file.
        var current = root
        for (index, component) in inside.enumerated() {
            current += "/" + component
            let isLeaf = index == inside.count - 1
            switch kind(of: current) {
            case .symlink: return .failure(.symlink)
            case .missing: return .failure(.missing)
            case .directory: if isLeaf { return .failure(.notRegularFile) }
            case .regular: if !isLeaf { return .failure(.outsideStaging) }
            case .other: return .failure(.notRegularFile)
            }
        }
        return .success(URL(fileURLWithPath: current, isDirectory: false))
    }

    private enum Kind { case regular, directory, symlink, other, missing }

    /// `lstat`, so a link is reported as a link and never followed. It also
    /// never opens anything, which is what keeps a FIFO from blocking here.
    private static func kind(of path: String) -> Kind {
        var st = stat()
        guard lstat(path, &st) == 0 else { return .missing }
        switch st.st_mode & S_IFMT {
        case S_IFREG: return .regular
        case S_IFDIR: return .directory
        case S_IFLNK: return .symlink
        default: return .other
        }
    }

    private static func canonical(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
// staged-file gate: END
