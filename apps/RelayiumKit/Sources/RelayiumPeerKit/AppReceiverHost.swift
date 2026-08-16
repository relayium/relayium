import Foundation
import RelayiumAppKit
import RelayiumKit

/// The app's own receive machinery, assembled exactly as `RelayiumApp`
/// assembles it — extracted from `NearbyReceiveE2E`'s `Receiver`.
///
/// **Why the receiving half must be this and not `PlainPeer`.** Two hand-built
/// peers prove the transport and nothing else. What has to work for a user is
/// that the app is sitting there, nobody has clicked anything, an offer arrives,
/// and it is answered — a path that runs through the residency socket, the
/// persistent signal listener, the offer classifier, the inbound reservation,
/// the buffer handoff, the real `RealtimeSessionModel` and the real writer. Every
/// one of those is production code, and none of them is reachable from a peer a
/// harness built.
///
/// **Isolation is a constructor argument, not a convention.** The receive root,
/// the defaults domain and the run tag are all handed in, because the three
/// things this host would otherwise inherit from the machine are the three that
/// have each already produced a wrong acceptance result somewhere in this
/// workspace: a receive that landed in the owner's Downloads, a preference the
/// person running it had changed, and a staged artefact that outlived the run
/// that made it.
@MainActor
public final class AppReceiverHost {

    public struct Options {
        /// The origin to assemble every factory against. The caller resolves it;
        /// this type does not read `ProcessInfo`, so a host built in a test is
        /// built against the origin that test chose.
        public var baseURL: URL
        /// The announced room name a counterpart matches on.
        public var name: String
        /// Where received files land.
        ///
        /// **Never a default, and never Downloads.** `AppEnvironment`'s own
        /// default receive directory IS the user's Downloads folder, which is
        /// correct for the product and unacceptable for an acceptance run: it
        /// writes real files into a real person's folder, and a run that
        /// crashed before its cleanup would leave them there.
        public var receiveRoot: URL
        /// A throwaway `UserDefaults` domain, so the verification preference
        /// stays at its shipped default without touching whatever the person
        /// running this has chosen — and so one run cannot inherit another's.
        public var defaultsSuite: String

        public init(baseURL: URL, name: String, receiveRoot: URL, defaultsSuite: String) {
            self.baseURL = baseURL
            self.name = name
            self.receiveRoot = receiveRoot
            self.defaultsSuite = defaultsSuite
        }
    }

    public let options: Options
    public let discovery: LanDiscoveryModel
    public let fileModel: RealtimeSessionModel
    public let textModel: RealtimeTextSessionModel
    public let receive: NearbyReceiveModel

    /// The `link/1` half, composed for the same reason `RelayiumApp` composes
    /// one: `LanDiscoveryModel` ANNOUNCES the capability in this room already —
    /// `LINK_BUILD_SUPPORT` is true for `os(macOS)`, which this binary is — and a
    /// process that announces a wire it cannot answer fails the establishment it
    /// invited. See `LinkCounterpart` for the full account; the short version is
    /// that a built App is the first client to take the announcement seriously,
    /// so T2b is the first run that could ever have observed the gap.
    ///
    /// Both halves on one room socket, exactly as the shipped apps have them: a
    /// legacy peer still reaches the legacy machinery above, because a peer that
    /// never announced `link/1` is never routed here.
    public let link: LinkWorkspaceModel
    public let linkCounterpart: LinkCounterpart

    private let defaults: UserDefaults

    public init(options: Options) throws {
        self.options = options
        try FileManager.default.createDirectory(at: options.receiveRoot,
                                                withIntermediateDirectories: true)
        guard let defaults = UserDefaults(suiteName: options.defaultsSuite) else {
            throw HostError.unusableDefaultsSuite(options.defaultsSuite)
        }
        self.defaults = defaults
        let verification = VerificationPreference(defaults: defaults)

        let baseURL = options.baseURL
        let name = options.name
        discovery = LanDiscoveryModel(connect: {
            SignalingClient.connect(
                wsBase: RealtimeConnectionFactory.signalingBase(baseURL),
                code: "",
                name: name)
        })
        let inboundRoom = InboundRoom()
        fileModel = AppEnvironment.makeRealtimeModel(
            baseURL: baseURL, verification: verification,
            nearby: discovery, inboundRoom: inboundRoom,
            // The same-network path only: this host never joins a code, so the
            // pairing room stays empty and the fallback builder simply refuses.
            pairingRoom: LinkRoomHandle())
        fileModel.saveDirectory = options.receiveRoot
        textModel = AppEnvironment.makeRealtimeTextModel(
            baseURL: baseURL, verification: verification,
            nearby: discovery, inboundRoom: inboundRoom,
            pairingRoom: LinkRoomHandle())
        receive = AppEnvironment.makeNearbyReceiveModel(
            fileModel: fileModel, textModel: textModel,
            discovery: discovery, inboundRoom: inboundRoom)

        // `receiveDirectory` is passed EXPLICITLY and is never allowed to
        // default. `AppEnvironment.makeLinkWorkspaceModel`'s macOS overload
        // defaults it to `defaultLinkReceiveDirectory()`, which is the user's
        // Downloads folder — the exact outcome `Options.receiveRoot` exists to
        // prevent, and one that would have been reintroduced silently here by
        // omitting one argument.
        let receiveRoot = options.receiveRoot
        link = AppEnvironment.makeLinkWorkspaceModel(
            baseURL: baseURL, verification: verification, nearby: discovery,
            // This host never watches a pairing code, so the handle stays empty
            // and `watchPairingCode` is never called — the same shape the nearby
            // legacy models above are given.
            pairingRoom: LinkRoomHandle(),
            receiveDirectory: { receiveRoot })
        linkCounterpart = LinkCounterpart(link: link)
    }

    public enum HostError: Error, Equatable {
        case unusableDefaultsSuite(String)
    }

    /// The one call `RelayiumApp` makes at launch.
    ///
    /// The link's headless answers are attached BEFORE the room is joined: a
    /// peer can be dialling the instant the socket opens, and an admission gate
    /// installed afterwards would race the first offer it exists to answer.
    public func start() {
        linkCounterpart.start()
        discovery.startResident()
    }

    public func teardown() {
        link.leave()
        discovery.stop()
        defaults.removePersistentDomain(forName: options.defaultsSuite)
        try? FileManager.default.removeItem(at: options.receiveRoot)
    }

    /// Everything this host has taken over EVERY link it served, plus the legacy
    /// wire's own result.
    ///
    /// What a launcher checks once the app has gone: by then the live link has
    /// ended and been dismissed, so the current link alone would report nothing
    /// about the run it just served.
    public func allReceipts() -> [FileReceipt] {
        fileReceipts(model: fileModel, root: options.receiveRoot)
            + linkCounterpart.allReceipts()
    }

    /// Every message received over every link this host served.
    public func allMessages() -> [String] { linkCounterpart.allMessages() }

    /// What the app's own writer put on disk, read back off disk.
    ///
    /// Deliberately re-read rather than reported from the model's in-memory
    /// state: the claim being evidenced is that the bytes are in files a person
    /// could open, and a receipt derived from the buffer the writer was handed
    /// would hold just as well for a writer that never flushed.
    ///
    /// Paths are relative to the container the receiver built (or to the receive
    /// root when a single-root batch needed none), so a receiver that flattened
    /// a folder shows up as a differing receipt rather than as a path that
    /// happens to end in the right name.
    public func receipts() -> [FileReceipt] {
        let legacy = fileReceipts(model: fileModel, root: options.receiveRoot)
        // One host, two wires, and never both in one run: a peer is legacy or it
        // is `link/1`, decided by an announcement made before anybody dialled.
        // Concatenated rather than chosen between, so a run that somehow drove
        // both reports both and the launcher's comparison fails loudly on the
        // extra files instead of quietly reporting one wire's half.
        return legacy + linkCounterpart.receipts()
    }

    /// The message bodies the CURRENT link received, in arrival order.
    ///
    /// Empty for the legacy wire, which carries its text through
    /// `RealtimeTextSessionModel` and is not what any T2b path drives.
    public func receivedMessages() -> [String] { linkCounterpart.current.messages }

    /// The digits the CURRENT link derived, or nil before it produced any.
    ///
    /// Scoped to the current link deliberately. A process-wide "the last SAS we
    /// ever saw" once satisfied a poll for a link that had never been
    /// established — see `LinkRecord`.
    public func linkSAS() -> String? { linkCounterpart.current.sas }

    /// Which link is being served, counting from 1; 0 before the first.
    public func linkEpoch() -> Int { linkCounterpart.current.epoch }
}

/// What a completed `RealtimeSessionModel` actually left on disk.
///
/// Shared by both hosts because both have to answer the same question about the
/// same model, and a second copy would be a second opinion about where the
/// container is.
@MainActor
public func fileReceipts(model: RealtimeSessionModel, root: URL) -> [FileReceipt] {
    guard case let .completed(urls) = model.state else { return [] }
    let base = (model.receivedContainer ?? root).standardized.path
    return urls.map { url in
        let full = url.standardized.path
        let relative = full.hasPrefix(base + "/")
            ? String(full.dropFirst(base.count + 1))
            : full
        let size = (try? FileManager.default
            .attributesOfItem(atPath: url.path))?[.size] as? Int
        return FileReceipt(name: url.lastPathComponent,
                           path: relative == url.lastPathComponent ? nil : relative,
                           size: size ?? -1,
                           sha256: sha256Hex(contentsOf: url) ?? "")
    }
}

/// The app's own **pairing-code** machinery, assembled as `RelayiumApp`
/// assembles it for a build with no nearby half.
///
/// The code path and the nearby path are different production code — a
/// different factory, a different room, a real `/api/pair` mint on the sending
/// side and a real `/api/ice` fetch on both — so evidencing one says nothing
/// about the other. This drives the same `RealtimeSessionModel` entry points the
/// transfer surface calls: `stageSend`, `mintCode`, and `join(code:role:)`.
@MainActor
public final class AppPairHost {

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
    public let model: RealtimeSessionModel
    private let defaults: UserDefaults

    public init(options: Options) throws {
        self.options = options
        try FileManager.default.createDirectory(at: options.receiveRoot,
                                                withIntermediateDirectories: true)
        guard let defaults = UserDefaults(suiteName: options.defaultsSuite) else {
            throw AppReceiverHost.HostError.unusableDefaultsSuite(options.defaultsSuite)
        }
        self.defaults = defaults
        // The shipped default is verification OFF, and this reads it from a
        // domain of its own rather than from whatever the person running this
        // has chosen — the same isolation the nearby host uses, for the same
        // reason: a run that behaved differently on the author's machine than
        // on anybody else's would be measuring the machine.
        model = AppEnvironment.makeRealtimeModel(
            baseURL: options.baseURL,
            verification: VerificationPreference(defaults: defaults))
        model.saveDirectory = options.receiveRoot
    }

    public func receipts() -> [FileReceipt] {
        fileReceipts(model: model, root: options.receiveRoot)
    }

    public func teardown() {
        model.cancel()
        defaults.removePersistentDomain(forName: options.defaultsSuite)
        try? FileManager.default.removeItem(at: options.receiveRoot)
    }
}
